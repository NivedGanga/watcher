"""Build events and signals, redact them, and enqueue them locally."""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone

BLOCKING_TYPES = {"question", "failed", "timed_out"}
NON_BLOCKING_TYPES = {"done", "stalled"}
EVENT_TYPES = BLOCKING_TYPES | NON_BLOCKING_TYPES

# Fixed summaries sent instead of real text in privacy mode "metadata".
METADATA_SUMMARIES = {
    "question": "Question from {agent}",
    "done": "Finished: {agent}",
    "failed": "Failed: {agent}",
    "timed_out": "Timed out: {agent}",
    "stalled": "Stalled: {agent}",
}

MAX_AGENT = 64
MAX_RUN_ID = 64
MAX_HOST = 128
MAX_SUMMARY = 200


def now_rfc3339() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def new_run_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4()}"


def _one_line(text: str) -> str:
    return " ".join(str(text).splitlines())


def build_event(
    *,
    event_type: str,
    agent: str,
    run_id: str,
    host: str,
    summary: str,
    exit_code: int | None,
    duration_s: float | None,
    email_allowed: bool,
    redactor,
    privacy_mode: str = "full",
    timestamp: str | None = None,
) -> dict:
    """Build an event dict; free-text fields are redacted first."""
    if event_type not in EVENT_TYPES:
        raise ValueError(f"unknown event type {event_type!r}")
    agent = redactor.redact(agent)[:MAX_AGENT] or "agent"
    host = redactor.redact(host)[:MAX_HOST] or "host"
    if privacy_mode == "metadata":
        summary = METADATA_SUMMARIES[event_type].format(agent=agent)
    else:
        summary = redactor.redact(summary)
    return {
        "id": str(uuid.uuid4()),
        "agent": agent,
        "run_id": str(run_id)[:MAX_RUN_ID],
        "host": host,
        "type": event_type,
        "blocking": event_type in BLOCKING_TYPES,
        "summary": _one_line(summary)[:MAX_SUMMARY],
        "exit_code": exit_code,
        "duration_s": duration_s,
        "email_allowed": bool(email_allowed),
        "timestamp": timestamp or now_rfc3339(),
    }


def build_signal(
    *,
    kind: str,
    run_id: str | None,
    idle_seconds: float | None = None,
    at: str | None = None,
) -> dict:
    signal = {
        "id": str(uuid.uuid4()),
        "kind": kind,
        "run_id": run_id if kind == "output_seen" else None,
        "at": at or now_rfc3339(),
    }
    if kind == "input_resumed":
        signal["idle_seconds"] = idle_seconds if idle_seconds is not None else 0
    else:
        signal["idle_seconds"] = None
    return signal


def enqueue_event(store, *, now: float | None = None, **kwargs) -> str:
    event = build_event(**kwargs)
    return store.enqueue("event", event, now if now is not None else time.time())


def enqueue_signal(store, *, now: float | None = None, **kwargs) -> str:
    signal = build_signal(**kwargs)
    return store.enqueue("signal", signal, now if now is not None else time.time())
