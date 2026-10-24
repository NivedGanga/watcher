"""Daemon ticks: drain, heartbeat cadence, stall guard, idle samples."""

import os

from agentwatch import events
from agentwatch.daemon import Daemon, IdleDetector
from agentwatch.delivery import Sender
from agentwatch.redact import Redactor


class FakeClock:
    def __init__(self, t=1_000_000.0):
        self.t = t

    def now(self):
        return self.t

    def advance(self, s):
        self.t += s


def _daemon(env, store, config, clock, sampler=None, backend_key=None):
    sender = Sender(store, config, now=clock.now)
    detector = IdleDetector(
        store, sampler or (lambda: None), 300.0, now=clock.now
    )
    return Daemon(
        store, config, sender=sender, idle_detector=detector, now=clock.now
    )


def test_tick_drains_and_heartbeats(env, store, backend, logged_in):
    clock = FakeClock()
    d = _daemon(env, store, logged_in, clock)
    d.tick()
    assert len(backend.heartbeats_received) == 1
    clock.advance(299)
    d.tick()
    assert len(backend.heartbeats_received) == 1  # not due yet
    clock.advance(2)
    d.tick()
    assert len(backend.heartbeats_received) == 2


def test_heartbeat_stops_when_loop_stalls(env, store, backend, logged_in):
    clock = FakeClock()
    d = _daemon(env, store, logged_in, clock)
    d.tick()
    assert len(backend.heartbeats_received) == 1
    # Simulate a stalled loop: no completed tick for >3 intervals.
    clock.advance(4 * 300 + 1)
    d.tick()
    assert len(backend.heartbeats_received) == 1


def test_heartbeat_reports_only_live_runs(env, store, backend, logged_in):
    clock = FakeClock()
    store.start_run("live", "a", pid=os.getpid(), now=clock.now())
    store.start_run("dead", "a", pid=2**22, now=clock.now())
    d = _daemon(env, store, logged_in, clock)
    d.tick()
    assert backend.heartbeats_received[-1]["active_runs"] == 1


def test_tick_drains_outbox(env, store, backend, logged_in):
    clock = FakeClock()
    r = Redactor()
    events.enqueue_event(
        store,
        event_type="done",
        agent="a",
        run_id="r",
        host="h",
        summary="s",
        exit_code=0,
        duration_s=None,
        email_allowed=True,
        redactor=r,
    )
    d = _daemon(env, store, logged_in, clock)
    d.tick()
    assert len(backend.events_received) == 1


def test_daemon_requires_key(env, store, config):
    # cli-level guard: daemon refuses without a key.
    from agentwatch import machinekey

    assert machinekey.permission_error() == (
        "Not logged in. Run: agentwatch login"
    )
