"""Install/remove the background service (launchd or systemd user unit).

The service is never started here; the start commands are printed for the
user to run.
"""

from __future__ import annotations

import os
import shutil
import sys
import sysconfig
from importlib import resources
from pathlib import Path

from . import paths

LAUNCHD_LABEL = "com.agentwatch.daemon"
SYSTEMD_UNIT = "agentwatch.service"


def _executable() -> str:
    found = shutil.which("agentwatch")
    if found:
        return str(Path(found).resolve())
    argv0 = Path(sys.argv[0]).resolve() if sys.argv and sys.argv[0] else None
    if argv0 and argv0.is_file() and os.access(argv0, os.X_OK):
        return str(argv0)
    scripts = Path(sysconfig.get_path("scripts")) / "agentwatch"
    if scripts.is_file():
        return str(scripts)
    return found or "agentwatch"


def _template(name: str) -> str:
    return (
        resources.files("agentwatch.data")
        .joinpath(name)
        .read_text(encoding="utf-8")
    )


def _render(template: str, executable: str) -> str:
    return template.replace("__AGENTWATCH_EXECUTABLE__", executable).replace(
        "__AGENTWATCH_DATA_DIR__", str(paths.data_dir())
    )


def launchd_plist_path() -> Path:
    return (
        Path.home() / "Library" / "LaunchAgents" / f"{LAUNCHD_LABEL}.plist"
    )


def systemd_unit_path() -> Path:
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "systemd" / "user" / SYSTEMD_UNIT


def service_path(platform: str | None = None) -> Path:
    platform = platform or sys.platform
    if platform == "darwin":
        return launchd_plist_path()
    return systemd_unit_path()


def is_installed(platform: str | None = None) -> bool:
    return service_path(platform).exists()


def install(platform: str | None = None, executable: str | None = None) -> list[str]:
    """Write the unit file. Returns lines to print for the user."""
    platform = platform or sys.platform
    exe = executable or _executable()
    if platform == "darwin":
        target = launchd_plist_path()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            _render(_template(LAUNCHD_LABEL + ".plist"), exe), encoding="utf-8"
        )
        uid = os.getuid()
        return [
            f"Wrote {target}",
            "Start the daemon with:",
            f"  launchctl bootstrap gui/{uid} {target}",
        ]
    target = systemd_unit_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        _render(_template(SYSTEMD_UNIT), exe), encoding="utf-8"
    )
    return [
        f"Wrote {target}",
        "Start the daemon with:",
        "  systemctl --user daemon-reload",
        "  systemctl --user enable --now agentwatch.service",
    ]


def uninstall(platform: str | None = None) -> list[str]:
    platform = platform or sys.platform
    target = service_path(platform)
    lines = []
    if platform == "darwin":
        uid = os.getuid()
        lines = [
            "Stop the daemon with:",
            f"  launchctl bootout gui/{uid}/{LAUNCHD_LABEL}",
        ]
    else:
        lines = [
            "Stop the daemon with:",
            "  systemctl --user disable --now agentwatch.service",
        ]
    if target.exists():
        target.unlink()
        lines.insert(0, f"Removed {target}")
    else:
        lines.insert(0, f"No service installed at {target}")
    return lines
