"""End-to-end `agentwatch run` tests + all spec scenario fixtures."""

import json
import os
import subprocess
import sys
import threading
import time

import pytest

from conftest import (
    FAKE_AGENT,
    SPEC_DIR,
    outbox_events,
    outbox_signals,
    run_cli,
    run_cli_blocking,
)

SCEN_DIR = SPEC_DIR / "fixtures" / "scenarios"
SCALE = 0.05


def _events_tuples(env):
    return [
        (e["type"], e["blocking"], e["email_allowed"])
        for e in outbox_events(env)
    ]


def test_run_exit_zero_done(env):
    rc, out, _ = run_cli_blocking(
        ["run", "--name", "demo", "--", "python3", "-c", "print('hi')"], env
    )
    assert rc == 0
    assert "hi" in out  # output passed through unchanged
    evts = outbox_events(env)
    assert len(evts) == 1
    e = evts[0]
    assert e["type"] == "done"
    assert e["blocking"] is False
    assert e["email_allowed"] is True  # notify_done defaults to true
    assert e["summary"] == "demo finished."
    assert e["exit_code"] == 0
    assert e["duration_s"] >= 0
    assert e["agent"] == "demo"
    assert e["run_id"]


def test_run_never_sends_command_or_started(env):
    run_cli_blocking(
        [
            "run", "--name", "demo", "--",
            "python3", "-c", "print('MARKER_CMD')",
        ],
        env,
    )
    for e in outbox_events(env):
        assert e["type"] != "started"
        assert "MARKER_CMD" not in json.dumps(e)
        assert "python3" not in json.dumps(e)


def test_run_exit_nonzero_failed(env):
    rc, _, _ = run_cli_blocking(
        ["run", "--name", "demo", "--", "python3", "-c",
         "import sys; sys.exit(7)"],
        env,
    )
    assert rc == 7
    (e,) = outbox_events(env)
    assert e["type"] == "failed"
    assert e["blocking"] is True
    assert e["email_allowed"] is True
    assert e["summary"] == "demo exited with code 7."
    assert e["exit_code"] == 7


def test_run_sigkill_failed(env):
    rc, _, _ = run_cli_blocking(
        ["run", "--name", "demo", "--", "python3", "-c",
         "import os,signal,time;time.sleep(0.2);os.kill(os.getpid(),9)"],
        env,
    )
    assert rc == 128 + 9
    (e,) = outbox_events(env)
    assert e["type"] == "failed"
    assert e["summary"] == "demo was killed by signal 9."
    assert e["exit_code"] is None


def test_run_notify_done_false(env):
    cfg_dir = env["config_dir"]
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "config.toml").write_text(
        "[agents.quiet]\nnotify_done = false\n"
    )
    rc, _, _ = run_cli_blocking(
        ["run", "--name", "quiet", "--", "python3", "-c", "pass"], env
    )
    assert rc == 0
    (e,) = outbox_events(env)
    assert e["type"] == "done"
    assert e["email_allowed"] is False


def test_run_timeout_kills_grandchild(env):
    pidfile = env["tmp"] / "grandchild.pid"
    script = (
        "import subprocess,time,sys;"
        f"g=subprocess.Popen(['sleep','60']);"
        f"open(r'{pidfile}','w').write(str(g.pid));"
        "time.sleep(60)"
    )
    rc, _, _ = run_cli_blocking(
        ["run", "--name", "demo", "--timeout", "1s", "--",
         "python3", "-c", script],
        env,
        timeout=30,
    )
    assert rc in (128 + 15, 128 + 9)
    (e,) = outbox_events(env)
    assert e["type"] == "timed_out"
    assert e["blocking"] is True
    assert e["email_allowed"] is True
    assert e["summary"] == "demo exceeded its timeout of 1s."
    gpid = int(pidfile.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(gpid, 0)


def test_run_stall_once_no_kill(env):
    # Output, silence past the stall window, more output, clean exit.
    script = (
        "import time;print('a',flush=True);time.sleep(2.5);"
        "print('b',flush=True);time.sleep(0.1)"
    )
    rc, _, _ = run_cli_blocking(
        ["run", "--name", "demo", "--stall", "1s", "--timeout", "20s", "--",
         "python3", "-c", script],
        env,
        timeout=40,
    )
    assert rc == 0
    types = [e["type"] for e in outbox_events(env)]
    assert types.count("stalled") == 1
    assert types[-1] == "done"
    stalled = [e for e in outbox_events(env) if e["type"] == "stalled"][0]
    assert stalled["summary"] == "demo has produced no output for 1s."
    assert stalled["blocking"] is False
    assert stalled["email_allowed"] is True


def test_run_forwards_sigterm_to_child_group(env):
    proc = run_cli(
        ["run", "--name", "demo", "--",
         "python3", "-c", "import time;time.sleep(30)"],
        env,
    )
    time.sleep(0.5)
    proc.terminate()  # SIGTERM to the wrapper -> forwarded to child's group
    proc.wait(timeout=10)
    (e,) = [x for x in outbox_events(env) if x["type"] == "failed"]
    assert e["summary"] == "demo was killed by signal 15."
    assert proc.returncode == 128 + 15


def test_output_seen_throttled(env):
    script = (
        "import time;"
        + "".join(
            f"print('x{i}',flush=True);time.sleep(0.15);" for i in range(8)
        )
    )
    rc, _, _ = run_cli_blocking(
        ["run", "--name", "demo", "--", "python3", "-c", script],
        env,
        extra_env={"AGENTWATCH_OUTPUT_SIGNAL_INTERVAL": "1.0"},
    )
    assert rc == 0
    sigs = [s for s in outbox_signals(env) if s["kind"] == "output_seen"]
    # 8 outputs over ~1.2s with a 1s throttle -> at most 2 signals.
    assert 1 <= len(sigs) <= 2
    for s in sigs:
        assert s["run_id"]
        assert s["idle_seconds"] is None


def test_ask_outside_run(env):
    rc, _, _ = run_cli_blocking(["ask", "deploy now?"], env)
    assert rc == 0
    (e,) = outbox_events(env)
    assert e["type"] == "question"
    assert e["blocking"] is True
    assert e["email_allowed"] is True
    assert e["agent"] == "adhoc"
    assert e["summary"] == "deploy now?"
    assert e["run_id"]  # generated


def test_done_command(env):
    rc, _, _ = run_cli_blocking(["done", "all wrapped up"], env)
    assert rc == 0
    (e,) = outbox_events(env)
    assert e["type"] == "done"
    assert e["blocking"] is False
    assert e["email_allowed"] is True
    assert e["summary"] == "all wrapped up"


def test_metadata_mode_hides_text(env):
    cfg_dir = env["config_dir"]
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "config.toml").write_text(
        '[general]\nprivacy_mode = "metadata"\n'
    )
    rc, _, _ = run_cli_blocking(
        ["run", "--name", "demo", "--", "python3", "-c",
         "print('SECRET-OUTPUT-XYZ')"],
        env,
    )
    assert rc == 0
    run_cli_blocking(["ask", "SECRET-QUESTION-XYZ?"], env)
    blobs = [json.dumps(e) for e in outbox_events(env)]
    for blob in blobs:
        assert "SECRET-OUTPUT-XYZ" not in blob
        assert "SECRET-QUESTION-XYZ" not in blob
        assert "python3" not in blob
    summaries = {e["type"]: e["summary"] for e in outbox_events(env)}
    assert summaries["done"] == "Finished: demo"
    assert summaries["question"] == "Question from adhoc"


# --- spec scenario fixtures -------------------------------------------------


def _answer_and_close(proc, delay: float):
    time.sleep(delay)
    try:
        proc.stdin.write(b"y\n")
        proc.stdin.flush()
        proc.stdin.close()
    except (BrokenPipeError, ValueError, OSError):
        pass


@pytest.mark.parametrize(
    "scenario_path",
    sorted(SCEN_DIR.glob("*.json")),
    ids=lambda p: p.stem,
)
def test_scenario(scenario_path, env):
    scenario = json.loads(scenario_path.read_text())
    params = scenario["params"]
    timeout_s = params["run_timeout_s"] * SCALE
    stall_s = params["stall_after_s"] * SCALE

    proc = run_cli(
        [
            "run",
            "--name",
            scenario["name"],
            "--timeout",
            f"{timeout_s}s",
            "--stall",
            f"{stall_s}s",
            "--",
            sys.executable,
            str(FAKE_AGENT),
            str(scenario_path),
        ],
        env,
        stdin=subprocess.PIPE,
        extra_env={"TIME_SCALE": str(SCALE)},
    )
    writer = None
    for step in scenario["steps"]:
        if "question" in step and step.get("answered"):
            delay = step.get("answer_delay_s", 30) * SCALE
            writer = threading.Thread(
                target=_answer_and_close, args=(proc, delay), daemon=True
            )
            writer.start()

    hard_timeout = timeout_s + 40
    try:
        proc.wait(timeout=hard_timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        pytest.fail("run did not finish in time")
    proc.stdout.read()
    err = proc.stderr.read()
    if writer:
        writer.join(timeout=5)
    if proc.stdin and not proc.stdin.closed:
        try:
            proc.stdin.close()
        except OSError:
            pass
    expected = [
        (e["type"], e["blocking"], e["email_allowed"])
        for e in scenario["expected_events"]
    ]
    got = _events_tuples(env)
    assert got == expected, (
        f"scenario {scenario['name']}: rc={proc.returncode} "
        f"stderr={err.decode()[:400]} expected {expected}, got {got}"
    )
