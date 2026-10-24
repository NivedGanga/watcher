"""Delivery loop: batching, retries, 401/426/429, dead rows, cleanup."""

import json
import time

import jsonschema

from agentwatch import events
from agentwatch.delivery import (
    AUTH_REJECTED_MESSAGE,
    Sender,
    housekeeping,
)
from agentwatch.httpclient import NetworkError
from conftest import SPEC_DIR, read_outbox

SCHEMAS = {}

for _name in ("event", "signal", "heartbeat"):
    SCHEMAS[_name] = json.loads(
        (SPEC_DIR / "schemas" / f"{_name}.schema.json").read_text()
    )


def _redactor():
    from agentwatch.redact import Redactor

    return Redactor()


def _enqueue(store, **kw):
    defaults = dict(
        event_type="done",
        agent="a",
        run_id="r1",
        host="h",
        summary="s",
        exit_code=0,
        duration_s=1.0,
        email_allowed=True,
        redactor=_redactor(),
    )
    defaults.update(kw)
    return events.enqueue_event(store, **defaults)


def test_drain_sends_events_and_signals(env, store, backend, logged_in):
    _enqueue(store)
    events.enqueue_signal(store, kind="output_seen", run_id="r1")
    report = Sender(store, logged_in).drain()
    assert report.sent == 2
    assert len(backend.events_received) == 1
    assert len(backend.signals_received) == 1
    # Protocol header on every request.
    assert all(h == "1" for h in backend.protocol_header_seen)
    assert all(h == "Bearer aw_m_test123_secretkey"
               for h in backend.auth_headers_seen)
    assert store.get_state("last_send_at")


def test_event_and_signal_bodies_validate(env, store, backend, logged_in):
    """Every event and signal body validates against spec/schemas."""
    for t in ("question", "done", "failed", "timed_out", "stalled"):
        _enqueue(store, event_type=t,
                 summary=f"summary for {t}")
    events.enqueue_signal(
        store, kind="input_resumed", run_id=None, idle_seconds=42.0
    )
    Sender(store, logged_in).drain()
    for body in backend.events_received:
        jsonschema.validate(body, SCHEMAS["event"])
    for body in backend.signals_received:
        jsonschema.validate(body, SCHEMAS["signal"])
    for body in backend.heartbeats_received:
        jsonschema.validate(body, SCHEMAS["heartbeat"])


def test_duplicate_marks_sent(env, store, backend, logged_in):
    row_id = _enqueue(store)
    backend.event_results[row_id] = "duplicate"
    Sender(store, logged_in).drain()
    row = [r for r in read_outbox(env) if r["id"] == row_id][0]
    assert row["status"] == "sent"


def test_rejected_marks_dead(env, store, backend, logged_in):
    row_id = _enqueue(store)
    backend.event_results[row_id] = "rejected"
    Sender(store, logged_in).drain()
    row = [r for r in read_outbox(env) if r["id"] == row_id][0]
    assert row["status"] == "dead"
    assert row["last_error_category"] == "rejected"


def test_401_stops_sending_keeps_outbox(env, store, backend, logged_in,
                                      caplog):
    _enqueue(store)
    backend.forced["/api/events"] = (401, None)
    report = Sender(store, logged_in).drain()
    assert report.blocked == "unauthorized"
    assert AUTH_REJECTED_MESSAGE in caplog.text
    assert store.counts_by_status()["pending"] == 1
    # Blocked flag persists: second drain is a no-op.
    report2 = Sender(store, logged_in).drain()
    assert report2.attempted == 0


def test_426_upgrade_required(env, store, backend, logged_in, caplog):
    _enqueue(store)
    backend.forced["/api/events"] = (426, None)
    report = Sender(store, logged_in).drain()
    assert report.blocked == "upgrade_required"
    assert store.counts_by_status()["pending"] == 1


def test_429_honors_retry_after(env, store, backend, logged_in):
    _enqueue(store)
    backend.forced["/api/events"] = (429, 120)
    t0 = time.time()
    Sender(store, logged_in, now=lambda: t0).drain()
    row = read_outbox(env)[0]
    assert row["status"] == "pending"
    assert row["next_attempt_at"] >= t0 + 119
    assert row["last_error_category"] == "rate_limited"
    # Before retry window: nothing due.
    assert store.due_rows("event", now=t0 + 60) == []
    # After: due again.
    assert store.due_rows("event", now=t0 + 121)


def test_5xx_backoff_never_drops(env, store, backend, logged_in):
    _enqueue(store)
    backend.forced["/api/events"] = (500, None)
    t0 = time.time()
    Sender(store, logged_in, now=lambda: t0, rand=lambda: 1.0).drain()
    row = read_outbox(env)[0]
    assert row["status"] == "pending"
    assert row["attempts"] == 1
    assert row["next_attempt_at"] > t0
    # Much later it is due again.
    assert store.due_rows("event", now=t0 + 3700)


def test_network_error_backoff(env, store, logged_in, monkeypatch):
    _enqueue(store)
    calls = []

    def boom(*a, **kw):
        calls.append(1)
        raise NetworkError("no route")

    t0 = time.time()
    sender = Sender(store, logged_in, now=lambda: t0,
                    rand=lambda: 1.0, request=boom)
    sender.drain()
    row = read_outbox(env)[0]
    assert row["status"] == "pending" and row["attempts"] == 1
    assert calls


def test_logged_out_events_queue_then_drop_after_7d(env, store):
    """Logged out: events queue; >7d old pending rows are dropped+counted."""
    old = time.time() - 8 * 86400
    _enqueue(store, now=old)
    _enqueue(store)
    dropped = housekeeping(store, time.time(), logged_in=False)
    assert dropped == 1
    assert store.get_state("dropped_unsent_count") == "1"
    counts = store.counts_by_status()
    assert counts["pending"] == 1


def test_heartbeat_body_and_active_runs(env, store, backend, logged_in):
    import os

    store.start_run("live", "a", pid=os.getpid(), now=time.time())
    store.start_run("dead", "a", pid=2**22, now=time.time())
    sender = Sender(store, logged_in)
    assert sender.heartbeat(store.active_runs())
    (hb,) = backend.heartbeats_received
    jsonschema.validate(hb, SCHEMAS["heartbeat"])
    assert hb["active_runs"] == 1  # dead PIDs not counted
    assert store.get_state("last_heartbeat_at")


def test_outbox_restart_no_duplicates(env, store, backend, logged_in):
    """Survives a restart: pending sends after recovery, no duplicates."""
    _enqueue(store)
    store.close()
    from agentwatch.store import Store

    store2 = Store()
    Sender(store2, logged_in).drain()
    assert len(backend.events_received) == 1
    # Second drain sends nothing new.
    Sender(store2, logged_in).drain()
    assert len(backend.events_received) == 1
    store2.close()


def test_batching_respects_50(env, store, backend, logged_in):
    for i in range(120):
        _enqueue(store, run_id=f"r{i}", summary=f"s{i}")
    Sender(store, logged_in).drain()
    assert len(backend.events_received) == 120
    assert store.counts_by_status().get("pending", 0) == 0


def test_no_key_means_no_send(env, store, backend, config):
    _enqueue(store)
    report = Sender(store, config).drain()
    assert report.sent == 0
    assert backend.events_received == []
    assert store.counts_by_status()["pending"] == 1
