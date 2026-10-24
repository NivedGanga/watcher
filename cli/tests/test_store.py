"""Outbox persistence, status transitions, runs table, state."""

import json
import time

from agentwatch import events
from agentwatch.store import Store, pid_alive



def test_wal_mode(store):
    mode = store.db.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode.lower() == "wal"


def test_enqueue_and_due(store):
    events.enqueue_signal(store, now=100.0, kind="output_seen", run_id="r1")
    rows = store.due_rows("signal", now=101.0)
    assert len(rows) == 1
    payload = json.loads(rows[0]["payload"])
    assert payload["kind"] == "output_seen"
    assert payload["run_id"] == "r1"


def test_outbox_survives_restart(env):
    """Pending rows persist across a new Store on the same file."""
    s1 = Store()
    events.enqueue_event(
        s1,
        event_type="done",
        agent="a",
        run_id="r1",
        host="h",
        summary="s",
        exit_code=0,
        duration_s=1.0,
        email_allowed=True,
        redactor=_null_redactor(),
    )
    s1.close()
    s2 = Store()
    rows = s2.due_rows("event", now=time.time())
    assert len(rows) == 1
    s2.close()


def _null_redactor():
    class R:
        def redact(self, t):
            return t or ""

    return R()


def test_mark_sent_and_dead(store):
    id1 = events.enqueue_signal(
        store, now=1.0, kind="output_seen", run_id="r1"
    )
    id2 = events.enqueue_signal(
        store, now=2.0, kind="output_seen", run_id="r2"
    )
    store.mark_sent([id1])
    store.mark_dead([id2], "rejected")
    counts = store.counts_by_status()
    assert counts["sent"] == 1 and counts["dead"] == 1


def test_next_attempt_at_defers(store):
    row_id = events.enqueue_signal(
        store, now=1.0, kind="output_seen", run_id="r1"
    )
    store.note_failure([row_id], "network", next_attempt_at=500.0)
    assert store.due_rows("signal", now=100.0) == []
    assert len(store.due_rows("signal", now=501.0)) == 1


def test_delete_sent_after_24h(store):
    row_id = events.enqueue_signal(
        store, now=100.0, kind="output_seen", run_id="r1"
    )
    store.mark_sent([row_id])
    assert store.delete_sent_older_than(100.0 + 24 * 3600 + 1) == 1
    # fresh sent row not deleted
    row_id2 = events.enqueue_signal(
        store, now=200.0, kind="output_seen", run_id="r2"
    )
    store.mark_sent([row_id2])
    assert store.delete_sent_older_than(150.0) == 0


def test_runs_active_count(store, monkeypatch):
    store.start_run("r1", "a", pid=999999, now=100.0)  # dead pid
    store.start_run("r2", "a", pid=__import__("os").getpid(), now=100.0)
    assert store.active_runs() == 1
    store.end_run("r2", now=200.0)
    assert store.active_runs() == 0


def test_pid_alive():
    import os

    assert pid_alive(os.getpid())
    assert not pid_alive(2**22)
    assert not pid_alive(None)


def test_question_flag(store):
    store.start_run("r1", "a", pid=1, now=100.0)
    assert not store.question_open("r1")
    store.open_question("r1", 110.0)
    assert store.question_open("r1")
    store.close_question("r1")
    assert not store.question_open("r1")


def test_state_kv(store):
    assert store.get_state("missing") is None
    store.set_state("k", "v")
    assert store.get_state("k") == "v"
    store.set_state("k", "v2")
    assert store.get_state("k") == "v2"


def test_drop_pending_older_than(store):
    import time as t

    events.enqueue_signal(store, now=t.time() - 8 * 86400,
                          kind="output_seen", run_id="old")
    events.enqueue_signal(store, now=t.time(),
                          kind="output_seen", run_id="new")
    dropped = store.drop_pending_older_than(t.time() - 7 * 86400)
    assert dropped == 1
    assert store.counts_by_status()["pending"] == 1
