#!/usr/bin/env python3
"""AgentWatch integration conformance harness.

Runs every scenario in ``spec/fixtures/scenarios/`` through the three
integration paths and checks that each produces the scenario's
``expected_events`` (same types, ``blocking`` and ``email_allowed``, in
order):

- Path A — ``agentwatch run`` wrapping a fake agent that only behaves
  (prints, sleeps, blocks, exits). The wrapper alone must detect it.
- Path B — the same fake agent, but ``question`` steps call
  ``agentwatch ask`` and expected ``done`` events call ``agentwatch done``,
  inside the wrapped run.
- Path C — a fake agent posting the same events to the API over direct
  HTTP (the urllib example from ../generic/http.md) against an in-process
  fake backend. No sockets are opened.

Paths B and C apply only to scenarios whose expected events include a
``question`` or a ``done`` — the types an agent can report itself. The
rest are reported ``n/a``. When no ``agentwatch`` command is available,
paths A and B are ``skip``ped.

Usage:
    python3 harness.py [--agentwatch CMD] [--scale S] [--scenario NAME]

``--agentwatch`` is the command prefix to run (default: ``agentwatch``
from PATH). Example against a source checkout:

    PYTHONPATH=../cli/src python3 harness.py --agentwatch "python3 -m agentwatch"

``--scale`` multiplies every scenario delay and the wrapper's stall /
timeout settings (default 0.1). Events are read from the CLI's local
outbox (``AGENTWATCH_DATA_DIR``); nothing is sent anywhere.

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fake_backend  # noqa: E402

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
SCENARIOS_DIR = REPO_ROOT / "spec" / "fixtures" / "scenarios"
FAKE_AGENT = HERE / "fake_agent.py"
MACHINE_KEY = "aw_m_conformance_test"

AGENT_REPORTED = {"question", "done"}  # types an agent can emit itself


# ---------------------------------------------------------------- events


def now_rfc3339() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def build_event(scenario: dict, expected: dict, run_id: str) -> dict:
    """A spec-conforming event of the expected type, like a direct-HTTP
    agent would construct it."""
    etype = expected["type"]
    prompt = next(
        (s["question"] for s in scenario["steps"] if "question" in s),
        None,
    )
    params = scenario.get("params", {})
    summaries = {
        "question": prompt or "Proceed?",
        "done": f"{scenario['name']} complete",
        "stalled": f"conformance produced no output for {params.get('stall_after_s', '?')}s.",
        "failed": "conformance exited with code 1.",
        "timed_out": f"conformance exceeded its timeout of {params.get('run_timeout_s', '?')}s.",
    }
    terminal = etype in ("done", "failed", "timed_out")
    return {
        "id": str(uuid.uuid4()),
        "agent": "conformance",
        "run_id": run_id,
        "host": "harness",
        "type": etype,
        "blocking": expected["blocking"],
        "summary": summaries[etype][:200],
        "exit_code": 1 if etype == "failed" else None,
        "duration_s": 1.0 if terminal else None,
        "email_allowed": expected["email_allowed"],
        "timestamp": now_rfc3339(),
    }


def compare(expected: list[dict], produced: list[dict]) -> list[str]:
    """Diff expected vs produced events on (type, blocking, email_allowed)."""
    diffs = []
    if len(produced) != len(expected):
        diffs.append(
            f"expected {len(expected)} event(s), produced {len(produced)}"
        )
    for i, (exp, got) in enumerate(zip(expected, produced)):
        for field in ("type", "blocking", "email_allowed"):
            if got.get(field) != exp.get(field):
                diffs.append(
                    f"event {i}: {field} expected {exp.get(field)!r}, "
                    f"got {got.get(field)!r} (type={got.get('type')!r})"
                )
                break
    extra = produced[len(expected):]
    for ev in extra:
        diffs.append(f"extra event: type={ev.get('type')!r} summary={ev.get('summary')!r}")
    return diffs


# ------------------------------------------------------- paths A and B


def plan_actions(steps: list[dict], scale: float):
    """Timed external actions: answers fed to stdin, signals to send."""
    actions = []
    t = 0.0
    for step in steps:
        if "output" in step:
            t += step.get("delay_s", 0) * scale
        elif "sleep_s" in step:
            t += step["sleep_s"] * scale
        elif "question" in step:
            if step.get("answered"):
                delay = step.get("answer_delay_s", 30) * scale
                actions.append((t + delay, ("answer",)))
                t += delay
            else:
                break
        elif "signal" in step:
            actions.append((t + step.get("after_s", 0) * scale,
                            ("signal", step["signal"])))
            break
        else:  # hang, exit — nothing further is reachable
            break
    return actions


def read_outbox_events(data_dir: Path) -> list[dict]:
    db_path = data_dir / "outbox.sqlite"
    if not db_path.exists():
        return []
    db = sqlite3.connect(str(db_path))
    try:
        rows = db.execute(
            "SELECT payload FROM outbox WHERE kind = 'event' "
            "ORDER BY created_at, rowid"
        ).fetchall()
    finally:
        db.close()
    return [json.loads(r[0]) for r in rows]


def run_wrapped(scenario: dict, agentwatch: list[str], scale: float,
                mode: str, workdir: Path) -> tuple[list[dict], str]:
    """Run the fake agent under `agentwatch run`; return (events, detail)."""
    params = scenario.get("params", {})
    timeout_s = max(1, round(params.get("run_timeout_s", 300) * scale))
    stall_s = max(1, round(params.get("stall_after_s", 60) * scale))

    cfg_dir = workdir / "config"
    data_dir = workdir / "data"
    cfg_dir.mkdir(parents=True)
    data_dir.mkdir(parents=True)
    pid_file = workdir / "agent.pid"

    # Keep nested `agentwatch ask/done` calls on the same interpreter when
    # the CLI is invoked as `python -m agentwatch`.
    watch = list(agentwatch)
    if len(watch) >= 2 and watch[0].startswith("python") and watch[1] == "-m":
        watch[0] = sys.executable

    env = dict(os.environ)
    env.update(
        {
            "AGENTWATCH_CONFIG_DIR": str(cfg_dir),
            "AGENTWATCH_DATA_DIR": str(data_dir),
            "AGENTWATCH_CMD": " ".join(watch),
        }
    )

    cmd = watch + [
        "run", "--name", "conformance",
        "--timeout", f"{timeout_s}s",
        "--stall", f"{stall_s}s",
        "--",
        sys.executable, str(FAKE_AGENT),
        "--scenario", str(workdir / "scenario.json"),
        "--mode", mode,
        "--scale", str(scale),
        "--pid-file", str(pid_file),
    ]
    (workdir / "scenario.json").write_text(json.dumps(scenario))

    log = open(workdir / "agentwatch.log", "wb")
    proc = subprocess.Popen(
        cmd, env=env, stdin=subprocess.PIPE, stdout=log,
        stderr=subprocess.STDOUT,
    )

    stop = threading.Event()

    def scheduler():
        start = time.monotonic()
        for offset, (kind, *rest) in plan_actions(scenario["steps"], scale):
            if stop.wait(max(0.0, start + offset - time.monotonic())):
                return
            if kind == "answer":
                try:
                    proc.stdin.write(b"y\n")
                    proc.stdin.flush()
                except (BrokenPipeError, OSError):
                    pass
            elif kind == "signal":
                signame = rest[0]
                for _ in range(100):
                    if pid_file.exists():
                        break
                    if stop.wait(0.05):
                        return
                try:
                    os.kill(int(pid_file.read_text().strip()),
                            getattr(signal, signame))
                except (OSError, ValueError):
                    pass

    thread = threading.Thread(target=scheduler, daemon=True)
    thread.start()
    try:
        proc.wait(timeout=timeout_s + 90)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        detail = f"harness killed run after {timeout_s + 90}s"
    else:
        detail = f"agentwatch exited {proc.returncode}"
    finally:
        stop.set()
        thread.join(timeout=5)
        log.close()

    return read_outbox_events(data_dir), detail


# -------------------------------------------------------------- path C


def post(opener, base: str, path: str, key: str, payload: dict):
    """The urllib example from generic/http.md, adapted only to take an
    explicit opener and base URL (the fake backend needs no sockets)."""
    req = urllib.request.Request(
        base + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "X-AgentWatch-Protocol": "1",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with opener.open(req, timeout=10) as resp:
        return resp.status, resp.read()


def run_direct_http(scenario: dict) -> tuple[list[dict], str]:
    """Path C: the fake agent posts events over 'HTTP' to a fake backend."""
    backend = fake_backend.FakeBackend(MACHINE_KEY)
    opener = backend.urllib_opener()
    base = "http://backend.invalid"
    run_id = f"c-{uuid.uuid4()}"

    errors = []
    status, _ = post(opener, base, "/api/heartbeat", MACHINE_KEY,
                     {"sent_at": now_rfc3339(), "active_runs": 1})
    if status != 204:
        errors.append(f"heartbeat returned {status}, expected 204")

    for expected in scenario["expected_events"]:
        event = build_event(scenario, expected, run_id)
        status, body = post(opener, base, "/api/events", MACHINE_KEY,
                            {"events": [event]})
        if status != 202:
            errors.append(f"/api/events returned {status}, expected 202")
            continue
        results = json.loads(body).get("results", [])
        if not results or results[0].get("status") != "accepted":
            errors.append(f"event {event['type']} not accepted: {results}")

    detail = "ok" if not errors else "; ".join(errors)
    return backend.events, detail


# ------------------------------------------------------------ reporting


def agentwatch_available(agentwatch: list[str]) -> bool:
    try:
        proc = subprocess.run(
            agentwatch + ["--version"], capture_output=True, timeout=10,
            env=os.environ,
        )
        return proc.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--agentwatch", default=None,
        help="command prefix for the agentwatch CLI "
        "(default: 'agentwatch' on PATH)",
    )
    ap.add_argument("--scale", type=float, default=0.1,
                    help="time scale for scenario delays (default 0.1)")
    ap.add_argument("--scenario", help="run one scenario by name")
    args = ap.parse_args()

    agentwatch = (
        shlex.split(args.agentwatch)
        if args.agentwatch
        else [shutil.which("agentwatch") or "agentwatch"]
    )
    cli_ok = agentwatch_available(agentwatch)

    scenario_paths = sorted(SCENARIOS_DIR.glob("*.json"))
    if args.scenario:
        scenario_paths = [p for p in scenario_paths
                          if p.stem == args.scenario]
        if not scenario_paths:
            print(f"no scenario named {args.scenario!r}")
            return 2

    results = []
    any_fail = False
    for path in scenario_paths:
        scenario = json.loads(path.read_text())
        name = scenario["name"]
        row = {"scenario": name}
        applicable_bc = any(
            e.get("type") in AGENT_REPORTED
            for e in scenario["expected_events"]
        )

        # Path A — bare wrapper.
        if not cli_ok:
            row["A"] = ("SKIP", "agentwatch command not available")
        else:
            with tempfile.TemporaryDirectory(prefix="aw-patha-") as td:
                produced, detail = run_wrapped(
                    scenario, agentwatch, args.scale, "observe", Path(td)
                )
            diffs = compare(scenario["expected_events"], produced)
            row["A"] = ("FAIL", "; ".join(diffs) or detail) if diffs else ("PASS", detail)

        # Path B — agent calls ask/done inside the wrapped run.
        if not applicable_bc:
            row["B"] = ("N/A", "no agent-reported events in scenario")
        elif not cli_ok:
            row["B"] = ("SKIP", "agentwatch command not available")
        else:
            with tempfile.TemporaryDirectory(prefix="aw-pathb-") as td:
                produced, detail = run_wrapped(
                    scenario, agentwatch, args.scale, "instrumented", Path(td)
                )
            diffs = compare(scenario["expected_events"], produced)
            row["B"] = ("FAIL", "; ".join(diffs) or detail) if diffs else ("PASS", detail)

        # Path C — direct HTTP against the fake backend.
        if not applicable_bc:
            row["C"] = ("N/A", "no agent-reported events in scenario")
        else:
            produced, detail = run_direct_http(scenario)
            diffs = compare(scenario["expected_events"], produced)
            row["C"] = ("FAIL", "; ".join(diffs) or detail) if diffs else ("PASS", detail)

        for p in ("A", "B", "C"):
            if row[p][0] == "FAIL":
                any_fail = True
        results.append(row)

    width = max(len(r["scenario"]) for r in results)
    print(f"{'scenario':<{width}}  {'A run':<6} {'B instr':<7} {'C http':<6}")
    for r in results:
        print(
            f"{r['scenario']:<{width}}  {r['A'][0]:<6} {r['B'][0]:<7} {r['C'][0]:<6}"
        )
        for p in ("A", "B", "C"):
            status, detail = r[p]
            if status in ("FAIL", "SKIP") or (
                status == "N/A" and detail != "no agent-reported events in scenario"
            ):
                print(f"  {p}: {detail}")

    n_pass = sum(1 for r in results for p in "ABC" if r[p][0] == "PASS")
    n_skip = sum(1 for r in results for p in "ABC" if r[p][0] == "SKIP")
    n_na = sum(1 for r in results for p in "ABC" if r[p][0] == "N/A")
    n_fail = sum(1 for r in results for p in "ABC" if r[p][0] == "FAIL")
    print(f"\n{n_pass} pass, {n_fail} fail, {n_skip} skipped, {n_na} n/a")
    return 1 if any_fail else 0


if __name__ == "__main__":
    sys.exit(main())
