#!/usr/bin/env python3
"""Fake agent that replays a spec scenario under ``agentwatch run``.

Two modes:

- ``observe`` (path A): does exactly what the scenario's step vocabulary
  says — prints, sleeps, prints a question prompt and blocks on stdin,
  hangs, exits. Emits no agentwatch calls; the wrapper alone reports.
- ``instrumented`` (path B): same, except a ``question`` step also calls
  ``agentwatch ask "<prompt>"`` before blocking on stdin, and an
  ``exit 0`` step calls ``agentwatch done "<summary>"`` first when the
  scenario expects a ``done`` event.

Timing: every ``delay_s``/``sleep_s``/``answer_delay_s`` is multiplied by
``--scale`` so runs stay short while preserving ordering and the
stall/timeout margins.

The agentwatch command for nested calls comes from ``AGENTWATCH_CMD``
(whitespace-split, e.g. ``python3 -m agentwatch``); default ``agentwatch``.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

AGENTWATCH = shlex.split(os.environ.get("AGENTWATCH_CMD", "agentwatch"))


def agentwatch(*args: str) -> None:
    """Call the agentwatch CLI; tolerate failure (instructions contract)."""
    try:
        subprocess.run(
            AGENTWATCH + list(args), timeout=15, check=False,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def wait_for_answer() -> None:
    """Block until a line arrives on stdin (or stdin closes)."""
    sys.stdin.readline()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", required=True)
    ap.add_argument("--mode", choices=("observe", "instrumented"),
                    default="observe")
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--pid-file")
    args = ap.parse_args()

    scenario = json.loads(Path(args.scenario).read_text())
    scale = args.scale

    if args.pid_file:
        Path(args.pid_file).write_text(str(os.getpid()))

    expects_done = any(
        e.get("type") == "done" for e in scenario.get("expected_events", [])
    )

    for step in scenario["steps"]:
        if "output" in step:
            time.sleep(step.get("delay_s", 0) * scale)
            print(step["output"], flush=True)
        elif "sleep_s" in step:
            time.sleep(step["sleep_s"] * scale)
        elif "question" in step:
            if args.mode == "instrumented":
                agentwatch("ask", step["question"])
            print(step["question"], flush=True)
            wait_for_answer()
        elif "hang" in step:
            while True:
                time.sleep(3600)
        elif "signal" in step:
            # The harness delivers the signal from outside; sleep until it
            # arrives.
            while True:
                time.sleep(3600)
        elif "exit" in step:
            code = step["exit"]
            if args.mode == "instrumented" and code == 0 and expects_done:
                agentwatch("done", f"{scenario['name']} complete")
            return code
    return 0


if __name__ == "__main__":
    sys.exit(main())
