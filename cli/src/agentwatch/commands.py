"""Implementations of ask, done, privacy, status, and test."""

from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timezone

from . import events, machinekey, service
from .delivery import DrainReport, Sender
from .store import Store

TEST_EVENT_TYPES = ["question", "done", "failed", "timed_out", "stalled"]

PRIVACY_EXPLANATIONS = {
    "full": (
        "full: the one-line summary of each event is sent after local "
        "secret redaction (API keys, tokens, passwords). Agent output and "
        "the command line are never sent."
    ),
    "metadata": (
        "metadata: only the event type, agent name, host, and timestamps "
        "leave the machine. Summaries are replaced with fixed lines "
        '("Question from {agent}", "Finished: {agent}", "Failed: {agent}", '
        '"Timed out: {agent}", "Stalled: {agent}"). Question text, exit '
        "messages, commands, and output are never sent. Redaction still "
        "runs."
    ),
}


def _run_identity() -> tuple[str, str]:
    """(agent, run_id) from the wrapper environment, or ad hoc defaults."""
    agent = os.environ.get("AGENTWATCH_AGENT") or "adhoc"
    run_id = os.environ.get("AGENTWATCH_RUN_ID") or events.new_run_id()
    return agent, run_id


def cmd_ask(question: str, store: Store, config, redactor) -> int:
    agent, run_id = _run_identity()
    now = time.time()
    events.enqueue_event(
        store,
        now=now,
        event_type="question",
        agent=agent,
        run_id=run_id,
        host=config.host_name,
        summary=question,
        exit_code=None,
        duration_s=None,
        email_allowed=True,
        redactor=redactor,
        privacy_mode=config.privacy_mode,
    )
    if store.get_run(run_id) is not None:
        store.open_question(run_id, now)
    return 0


def cmd_done(summary: str, store: Store, config, redactor) -> int:
    agent, run_id = _run_identity()
    events.enqueue_event(
        store,
        event_type="done",
        agent=agent,
        run_id=run_id,
        host=config.host_name,
        summary=summary,
        exit_code=None,
        duration_s=None,
        email_allowed=True,
        redactor=redactor,
        privacy_mode=config.privacy_mode,
    )
    return 0


def cmd_privacy(mode: str | None, config, out=print) -> int:
    if mode:
        config.set("general", "privacy_mode", mode)
        config.save()
        out(f"Privacy mode set to {mode}.")
    else:
        out(f"Privacy mode: {config.privacy_mode}")
    for m in ("full", "metadata"):
        out(f"  {PRIVACY_EXPLANATIONS[m]}")
    return 0


def _fmt_ts(epoch_s: str | None) -> str:
    if not epoch_s:
        return "never"
    try:
        ts = datetime.fromtimestamp(float(epoch_s), timezone.utc)
    except (TypeError, ValueError):
        return "unknown"
    return ts.isoformat(timespec="seconds").replace("+00:00", "Z")


def cmd_status(config, store: Store, out=print) -> int:
    logged_in = machinekey.logged_in()
    counts = store.counts_by_status()
    now = time.time()

    if logged_in:
        out("Logged in: yes")
    else:
        out("Logged in: no")
    out(f"Backend: {config.backend_url}")
    out(f"Machine ID: {config.machine_id or '-'}")
    out(
        "Outbox: "
        f"pending={counts.get('pending', 0)} "
        f"sent={counts.get('sent', 0)} "
        f"dead={counts.get('dead', 0)}"
    )
    out(f"Last successful send: {_fmt_ts(store.get_state('last_send_at'))}")
    out(f"Last heartbeat: {_fmt_ts(store.get_state('last_heartbeat_at'))}")
    out(f"Idle detection: {store.get_state('idle_mode', 'unknown')}")
    out(f"Privacy mode: {config.privacy_mode}")
    out(f"Service installed: {'yes' if service.is_installed() else 'no'}")

    dropped = int(store.get_state("dropped_unsent_count", "0") or 0)
    if dropped:
        out(f"Dropped while logged out (>7d): {dropped}")

    if not logged_in and counts.get("pending", 0):
        oldest = store.oldest_pending_created_at()
        age = f"{int(now - oldest)}s" if oldest else "unknown age"
        out(
            f"Waiting for login: {counts['pending']} event(s), "
            f"oldest {age} old"
        )
    return 0


def cmd_test(
    config,
    store: Store,
    redactor,
    *,
    out=print,
    err=lambda s: print(s, file=sys.stderr),
    sender: Sender | None = None,
) -> int:
    problem = machinekey.permission_error()
    if problem:
        err(problem)
        return 1

    run_id = events.new_run_id(prefix="test-")
    summaries = {
        "question": "Is the test working?",
        "done": "Test run finished.",
        "failed": "Test run exited with code 1.",
        "timed_out": "Test run exceeded its timeout.",
        "stalled": "Test run produced no output.",
    }
    ids: list[tuple[str, str]] = []
    for event_type in TEST_EVENT_TYPES:
        row_id = events.enqueue_event(
            store,
            event_type=event_type,
            agent="agentwatch-test",
            run_id=run_id,
            host=config.host_name,
            summary=summaries[event_type],
            exit_code=1 if event_type == "failed" else None,
            duration_s=None,
            email_allowed=True,
            redactor=redactor,
            privacy_mode=config.privacy_mode,
        )
        ids.append((event_type, row_id))

    sender = sender or Sender(store, config)
    report: DrainReport = sender.drain()
    if report.blocked == "upgrade_required":
        err(
            "This agentwatch is too old for the server. "
            "Run: pipx upgrade agentwatch"
        )
        return 1
    if report.blocked == "unauthorized":
        err("machine key rejected; run agentwatch logout, then agentwatch login")
        return 1

    exit_code = 0
    for event_type, row_id in ids:
        result = report.results.get(row_id)
        if result in ("accepted", "duplicate"):
            out(f"{event_type}: {result}")
        elif result is None:
            out(f"{event_type}: still pending (will retry)")
            exit_code = 1
        else:
            out(f"{event_type}: not accepted ({result})")
            exit_code = 1
    return exit_code
