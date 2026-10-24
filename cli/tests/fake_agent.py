#!/usr/bin/env python3
"""Replay a spec/fixtures/scenarios/*.json file as a fake agent.

Usage: fake_agent.py SCENARIO_JSON
Delays are multiplied by the TIME_SCALE env var (default 1.0).
Questions invoke `agentwatch ask` and block on stdin for the answer.
"""

import json
import os
import signal
import subprocess
import sys
import time

SCALE = float(os.environ.get("TIME_SCALE", "1.0"))


def sleep_s(seconds: float) -> None:
    time.sleep(max(0.0, seconds * SCALE))


def main() -> int:
    with open(sys.argv[1], encoding="utf-8") as fh:
        scenario = json.load(fh)

    for step in scenario["steps"]:
        if "output" in step:
            sleep_s(step.get("delay_s", 0))
            print(step["output"], flush=True)
        elif "sleep_s" in step:
            sleep_s(step["sleep_s"])
        elif "question" in step:
            prompt = step["question"]
            print(prompt, flush=True)
            subprocess.run(
                [sys.executable, "-m", "agentwatch", "ask", prompt],
                check=False,
            )
            # Block for the answer; the harness writes it (or not).
            sys.stdin.readline()
        elif "signal" in step:
            sleep_s(step.get("after_s", 0))
            os.kill(os.getpid(), getattr(signal, step["signal"]))
        elif step.get("hang"):
            while True:
                time.sleep(60)
        elif "exit" in step:
            return int(step["exit"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
