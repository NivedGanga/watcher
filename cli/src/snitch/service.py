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

LAUNCHD_LABEL = "com.snitch.daemon"
SYSTEMD_UNIT = "snitch.service"


def _executable() -> str:
    found = shutil.which("snitch")
    if found:
        return str(Path(found).resolve())
    argv0 = Path(sys.argv[0]).resolve() if sys.argv and sys.argv[0] else None
    if argv0 and argv0.is_file() and os.access(argv0, os.X_OK):
        return str(argv0)
    scripts = Path(sysconfig.get_path("scripts")) / "snitch"
    if scripts.is_file():
        return str(scripts)
    return found or "snitch"


def _template(name: str) -> str:
    return (
        resources.files("snitch.data")
        .joinpath(name)
        .read_text(encoding="utf-8")
    )


def _render(template: str, executable: str) -> str:
    return template.replace("__SNITCH_EXECUTABLE__", executable).replace(
        "__SNITCH_DATA_DIR__", str(paths.data_dir())
    )


def launchd_plist_path() -> Path:
    base = Path.home() / "Library" / "LaunchAgents"
    target = base / f"{LAUNCHD_LABEL}.plist"
    legacy = base / "com.agentwatch.daemon.plist"
    return legacy if not target.exists() and legacy.exists() else target


def systemd_unit_path() -> Path:
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    base = base / "systemd" / "user"
    target = base / SYSTEMD_UNIT
    legacy = base / "agentwatch.service"
    return legacy if not target.exists() and legacy.exists() else target


def service_path(platform: str | None = None) -> Path:
    platform = platform or sys.platform
    if platform == "darwin":
        return launchd_plist_path()
    return systemd_unit_path()


def supported(platform: str | None = None) -> bool:
    return (platform or sys.platform) != "win32"


def is_installed(platform: str | None = None) -> bool:
    return supported(platform) and service_path(platform).exists()


def install(platform: str | None = None, executable: str | None = None) -> list[str]:
    """Write the unit file. Returns lines to print for the user."""
    platform = platform or sys.platform
    exe = executable or _executable()
    if platform == "darwin":
        target = launchd_plist_path()
        replacing = target.exists()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            _render(_template(LAUNCHD_LABEL + ".plist"), exe).replace(LAUNCHD_LABEL, target.stem),
            encoding="utf-8",
        )
        uid = os.getuid()
        return [
            f"Wrote {target}",
            "Start the daemon with:",
            *([f"  launchctl bootout gui/{uid}/{target.stem}"] if replacing else []),
            f"  launchctl bootstrap gui/{uid} {target}",
        ]
    target = systemd_unit_path()
    replacing = target.exists()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        _render(_template(SYSTEMD_UNIT), exe), encoding="utf-8"
    )
    return [
        f"Wrote {target}",
        "Start the daemon with:",
        "  systemctl --user daemon-reload",
        f"  systemctl --user enable --now {target.name}",
        *([f"  systemctl --user restart {target.name}"] if replacing else []),
    ]


def uninstall(platform: str | None = None) -> list[str]:
    platform = platform or sys.platform
    target = service_path(platform)
    lines = []
    if platform == "darwin":
        uid = os.getuid()
        lines = [
            "Stop the daemon with:",
            f"  launchctl bootout gui/{uid}/{target.stem}",
        ]
    else:
        lines = [
            "Stop the daemon with:",
            f"  systemctl --user disable --now {target.name}",
        ]
    if target.exists():
        target.unlink()
        lines.insert(0, f"Removed {target}")
    else:
        lines.insert(0, f"No service installed at {target}")
    return lines
