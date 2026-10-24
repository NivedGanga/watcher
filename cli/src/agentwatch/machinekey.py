"""The one secret the CLI holds: the machine key at
``~/.config/agentwatch/machine.key`` (mode 0600)."""

from __future__ import annotations

import os
import stat
from pathlib import Path

from . import paths

EXPECTED_MODE = 0o600


def write_key(key: str, path: Path | None = None) -> Path:
    """Create the key file via os.open with mode 0600 before writing."""
    path = path or paths.machine_key_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, EXPECTED_MODE)
    try:
        os.fchmod(fd, EXPECTED_MODE)
        os.write(fd, key.encode("utf-8"))
    finally:
        os.close(fd)
    return path


def read_key(path: Path | None = None) -> str | None:
    path = path or paths.machine_key_path()
    try:
        return path.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def delete_key(path: Path | None = None) -> None:
    path = path or paths.machine_key_path()
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def logged_in(path: Path | None = None) -> bool:
    return read_key(path) is not None


def permission_error(path: Path | None = None) -> str | None:
    """Return a refusal message if the key is missing or has the wrong mode."""
    path = path or paths.machine_key_path()
    if not path.exists():
        return "Not logged in. Run: agentwatch login"
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode != EXPECTED_MODE:
        return (
            f"{path} has mode {mode:04o}; expected 0600.\n"
            f"Fix it with: chmod 600 {path}"
        )
    return None
