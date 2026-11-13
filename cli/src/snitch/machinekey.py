"""Store the machine key with POSIX permissions or Windows user encryption."""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path
from tempfile import NamedTemporaryFile

from . import paths

EXPECTED_MODE = 0o600


def write_key(key: str, path: Path | None = None) -> Path:
    path = path or paths.machine_key_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        from . import _windows

        protected = _windows.protect_key(key.encode("utf-8"))
        temp = NamedTemporaryFile(dir=path.parent, delete=False)
        try:
            with temp:
                temp.write(protected)
            os.replace(temp.name, path)
        finally:
            Path(temp.name).unlink(missing_ok=True)
        return path
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
        if sys.platform == "win32":
            from . import _windows

            key = _windows.protect_key(path.read_bytes(), decrypt=True).decode("utf-8")
        else:
            key = path.read_text(encoding="utf-8")
        return key.strip() or None
    except (OSError, UnicodeError):
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
        return "Not logged in. Run: snitch login"
    if sys.platform == "win32":
        if not read_key(path):
            return "Cannot read the Windows machine key. Run: snitch logout, then snitch login"
        return None
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode != EXPECTED_MODE:
        return (
            f"{path} has mode {mode:04o}; expected 0600.\n"
            f"Fix it with: chmod 600 {path}"
        )
    return None
