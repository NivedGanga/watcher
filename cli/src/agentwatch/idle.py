"""User-idle sampling: ``ioreg`` on macOS, ``xprintidle`` on Linux."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys

SAMPLE_INTERVAL_SECONDS = 30.0
INPUT_THRESHOLD_SECONDS = 5.0

_HID_IDLE_RE = re.compile(r'"HIDIdleTime"\s*=\s*(\d+)')


def detect_mode(platform: str | None = None, which=shutil.which) -> str:
    """Return 'hid', 'xprintidle', or 'none'."""
    platform = platform or sys.platform
    if platform == "darwin":
        return "hid"
    if platform.startswith("linux") and which("xprintidle"):
        return "xprintidle"
    return "none"


def _ioreg_idle_seconds(run=subprocess.run) -> float | None:
    try:
        proc = run(
            ["ioreg", "-c", "IOHIDSystem"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = _HID_IDLE_RE.search(proc.stdout or "")
    if not match:
        return None
    return int(match.group(1)) / 1e9


def _xprintidle_seconds(run=subprocess.run) -> float | None:
    try:
        proc = run(
            ["xprintidle"], capture_output=True, text=True, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        return None
    try:
        return float((proc.stdout or "").strip()) / 1000.0
    except ValueError:
        return None


def make_sampler(mode: str, run=subprocess.run):
    """Return a callable giving idle seconds, or None when unsupported."""
    if mode == "hid":
        return lambda: _ioreg_idle_seconds(run)
    if mode == "xprintidle":
        return lambda: _xprintidle_seconds(run)
    return lambda: None
