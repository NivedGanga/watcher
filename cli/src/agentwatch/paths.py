"""Filesystem locations and platform support checks."""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "agentwatch"

UNSUPPORTED_PLATFORM_MESSAGE = (
    "AgentWatch supports macOS and Linux (WSL included) in this version."
)


def platform_supported() -> bool:
    """Native Windows is unsupported; macOS and Linux (incl. WSL) are."""
    return not sys.platform.startswith("win")


def client_os() -> str:
    if sys.platform == "darwin":
        return "macos"
    return "linux"


def config_dir() -> Path:
    override = os.environ.get("AGENTWATCH_CONFIG_DIR")
    if override:
        return Path(override)
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / APP_NAME


def data_dir() -> Path:
    override = os.environ.get("AGENTWATCH_DATA_DIR")
    if override:
        return Path(override)
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / APP_NAME


def config_path() -> Path:
    return config_dir() / "config.toml"


def machine_key_path() -> Path:
    return config_dir() / "machine.key"


def outbox_path() -> Path:
    return data_dir() / "outbox.sqlite"
