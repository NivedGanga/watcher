"""Load, validate, and update ~/.config/agentwatch/config.toml.

The config file never holds secrets; the machine key lives separately in
``machine.key`` with mode 0600.
"""

from __future__ import annotations

import os
import re
import socket
import tomllib
from pathlib import Path
from urllib.parse import urlparse

from . import paths

DEFAULT_BACKEND_URL = "https://api.alerts.example.com"
DEFAULT_HEARTBEAT_INTERVAL_MINUTES = 5
DEFAULT_RETURN_IDLE_MINUTES = 5
DEFAULT_PRIVACY_MODE = "full"
DEFAULT_AGENT_TIMEOUT = "2h"
DEFAULT_AGENT_STALL = "15m"
DEFAULT_NOTIFY_DONE = True

_PRIVACY_MODES = ("full", "metadata")


class ConfigError(Exception):
    """The configuration file is missing, malformed, or invalid."""


def dev_mode() -> bool:
    return os.environ.get("AGENTWATCH_DEV") == "1"


def sanitize_hostname(raw: str | None = None) -> str:
    """Turn a hostname into a safe client/machine display name."""
    name = (raw if raw is not None else socket.gethostname()).split(".")[0]
    name = name.strip().lower()
    name = re.sub(r"[^a-z0-9_-]+", "-", name).strip("-")
    return name or "machine"


_DURATION_PART = re.compile(r"(\d+(?:\.\d+)?)([smhd]?)")
_DURATION_MULTIPLIERS = {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}


def parse_duration(text: str) -> float:
    """Parse durations like ``"2h"``, ``"15m"``, ``"300s"``, ``"1h30m"``.

    A bare number means seconds. Raises ValueError on bad input.
    """
    text = text.strip().lower()
    if not text:
        raise ValueError("empty duration")
    total = 0.0
    pos = 0
    for match in _DURATION_PART.finditer(text):
        if match.start() != pos:
            raise ValueError(f"invalid duration: {text!r}")
        total += float(match.group(1)) * _DURATION_MULTIPLIERS[match.group(2)]
        pos = match.end()
    if pos != len(text) or pos == 0:
        raise ValueError(f"invalid duration: {text!r}")
    return total


def _toml_quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _toml_value(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, list):
        return "[" + ", ".join(_toml_value(v) for v in value) + "]"
    return _toml_quote(str(value))


def dump_toml(data: dict) -> str:
    """Serialize the limited config shape (sections of scalar keys)."""
    lines: list[str] = []
    for section in ("general", "heartbeat", "idle"):
        body = data.get(section)
        if not body:
            continue
        lines.append(f"[{section}]")
        for key, value in body.items():
            lines.append(f"{key} = {_toml_value(value)}")
        lines.append("")
    agents = data.get("agents") or {}
    for name in sorted(agents):
        lines.append(f"[agents.{name}]")
        for key, value in agents[name].items():
            lines.append(f"{key} = {_toml_value(value)}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


class AgentSettings:
    def __init__(self, name: str, raw: dict | None):
        raw = raw or {}
        self.name = name
        self.timeout = str(raw.get("timeout", DEFAULT_AGENT_TIMEOUT))
        self.stall = str(raw.get("stall", DEFAULT_AGENT_STALL))
        self.notify_done = bool(raw.get("notify_done", DEFAULT_NOTIFY_DONE))

    @property
    def timeout_seconds(self) -> float:
        return parse_duration(self.timeout)

    @property
    def stall_seconds(self) -> float:
        return parse_duration(self.stall)


class Config:
    def __init__(self, data: dict, path: Path):
        self._data = data
        self.path = path

    # -- general --------------------------------------------------------
    @property
    def backend_url(self) -> str:
        override = os.environ.get("AGENTWATCH_BACKEND_URL")
        if override and dev_mode():
            return override.rstrip("/")
        return self._data["general"]["backend_url"].rstrip("/")

    @property
    def host_name(self) -> str:
        return self._data["general"]["host_name"]

    @property
    def machine_id(self) -> str:
        return self._data["general"].get("machine_id", "")

    @property
    def privacy_mode(self) -> str:
        return self._data["general"]["privacy_mode"]

    @property
    def redact_env(self) -> list[str]:
        return list(self._data["general"].get("redact_env", []))

    # -- heartbeat / idle -----------------------------------------------
    @property
    def heartbeat_interval_seconds(self) -> float:
        return float(self._data["heartbeat"]["interval_minutes"]) * 60

    @property
    def return_idle_seconds(self) -> float:
        return float(self._data["idle"]["return_idle_minutes"]) * 60

    # -- agents -----------------------------------------------------------
    def agent(self, name: str) -> AgentSettings:
        return AgentSettings(name, self._data.get("agents", {}).get(name))

    # -- mutation ---------------------------------------------------------
    def set(self, section: str, key: str, value) -> None:
        self._data.setdefault(section, {})[key] = value

    def unset(self, section: str, key: str) -> None:
        self._data.get(section, {}).pop(key, None)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(dump_toml(self._data), encoding="utf-8")


def _defaults() -> dict:
    return {
        "general": {
            "backend_url": DEFAULT_BACKEND_URL,
            "host_name": sanitize_hostname(),
            "machine_id": "",
            "privacy_mode": DEFAULT_PRIVACY_MODE,
            "redact_env": [],
        },
        "heartbeat": {"interval_minutes": DEFAULT_HEARTBEAT_INTERVAL_MINUTES},
        "idle": {"return_idle_minutes": DEFAULT_RETURN_IDLE_MINUTES},
        "agents": {},
    }


def _validate_backend_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme == "https":
        return
    if (
        parsed.scheme == "http"
        and dev_mode()
        and parsed.hostname in ("localhost", "127.0.0.1", "::1")
    ):
        return
    raise ConfigError(
        f"backend_url must be https (got {url!r}); plain http is allowed only "
        "for localhost with AGENTWATCH_DEV=1"
    )


def _validate_section(data: dict, section: str) -> dict:
    body = data.get(section)
    if body is None:
        return {}
    if not isinstance(body, dict):
        raise ConfigError(f"[{section}] must be a table")
    return body


def load(path: Path | None = None) -> Config:
    """Load config.toml, filling defaults, and validate it."""
    path = path or paths.config_path()
    data = _defaults()
    if path.exists():
        try:
            raw = tomllib.loads(path.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError) as exc:
            raise ConfigError(f"cannot read {path}: {exc}") from exc
        for section in ("general", "heartbeat", "idle"):
            body = _validate_section(raw, section)
            for key, value in body.items():
                data[section][key] = value
        agents = raw.get("agents") or {}
        if not isinstance(agents, dict):
            raise ConfigError("[agents] must be a table of tables")
        for name, body in agents.items():
            if not isinstance(body, dict):
                raise ConfigError(f"[agents.{name}] must be a table")
            data["agents"][name] = dict(body)

    general = data["general"]
    if not isinstance(general.get("backend_url"), str):
        raise ConfigError("general.backend_url must be a string")
    if general.get("privacy_mode") not in _PRIVACY_MODES:
        raise ConfigError(
            f"general.privacy_mode must be one of {_PRIVACY_MODES} "
            f"(got {general.get('privacy_mode')!r})"
        )
    if not isinstance(general.get("redact_env"), list):
        raise ConfigError("general.redact_env must be a list of names")
    for key in ("interval_minutes",):
        if not isinstance(data["heartbeat"].get(key), (int, float)):
            raise ConfigError(f"heartbeat.{key} must be a number")
    if not isinstance(data["idle"].get("return_idle_minutes"), (int, float)):
        raise ConfigError("idle.return_idle_minutes must be a number")
    general["host_name"] = str(general.get("host_name") or sanitize_hostname())
    general["machine_id"] = str(general.get("machine_id") or "")

    _validate_backend_url(general["backend_url"])
    return Config(data, path)
