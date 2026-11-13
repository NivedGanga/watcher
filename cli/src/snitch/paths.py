"""Filesystem locations and platform identity."""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "snitch"


def env(name: str, default: str | None = None) -> str | None:
    """Prefer Snitch settings while accepting existing AgentWatch installs."""
    return os.environ.get(f"SNITCH_{name}", os.environ.get(f"AGENTWATCH_{name}", default))


def client_os() -> str:
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    return "linux"


def _windows_dir() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    return (Path(local) if local else Path.home() / "AppData" / "Local") / APP_NAME


def config_dir() -> Path:
    override = env("CONFIG_DIR")
    if override:
        return Path(override)
    if sys.platform == "win32":
        return _windows_dir()
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    target = base / APP_NAME
    legacy = base / "agentwatch"
    return legacy if not target.exists() and legacy.exists() else target


def data_dir() -> Path:
    override = env("DATA_DIR")
    if override:
        return Path(override)
    if sys.platform == "win32":
        return _windows_dir()
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    target = base / APP_NAME
    legacy = base / "agentwatch"
    return legacy if not target.exists() and legacy.exists() else target


def config_path() -> Path:
    return config_dir() / "config.toml"


def machine_key_path() -> Path:
    return config_dir() / "machine.key"


def outbox_path() -> Path:
    return data_dir() / "outbox.sqlite"
