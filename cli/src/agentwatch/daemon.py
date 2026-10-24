"""``agentwatch daemon`` — drain the outbox, heartbeat, idle detection."""

from __future__ import annotations

import logging
import signal
import threading
import time

from . import events, idle
from .delivery import Sender, housekeeping
from .store import Store

log = logging.getLogger("agentwatch.daemon")


class IdleDetector:
    """Emits ``input_resumed`` when idle drops below the input threshold
    after reaching the configured return-idle duration."""

    def __init__(
        self,
        store: Store,
        sample_fn,
        return_idle_s: float,
        *,
        now=time.time,
    ):
        self.store = store
        self.sample_fn = sample_fn
        self.return_idle_s = return_idle_s
        self.now = now
        self.last_idle: float | None = None
        self.peak_idle: float = 0.0

    def sample(self) -> str | None:
        idle_s = self.sample_fn()
        if idle_s is None:
            return None
        emitted = None
        if idle_s < idle.INPUT_THRESHOLD_SECONDS:
            if (
                self.last_idle is not None
                and self.peak_idle >= self.return_idle_s
            ):
                emitted = events.enqueue_signal(
                    self.store,
                    now=self.now(),
                    kind="input_resumed",
                    run_id=None,
                    idle_seconds=self.last_idle,
                )
            self.peak_idle = 0.0
        else:
            self.peak_idle = max(self.peak_idle, idle_s)
        self.last_idle = idle_s
        return emitted


class Daemon:
    def __init__(
        self,
        store: Store,
        config,
        sender: Sender | None = None,
        idle_detector: IdleDetector | None = None,
        *,
        now=time.time,
        sleep=time.sleep,
    ):
        self.store = store
        self.config = config
        self.sender = sender or Sender(store, config, now=now)
        self.now = now
        self.sleep = sleep
        self.stop_event = threading.Event()
        self.last_tick_completed = now()

        heartbeat_s = config.heartbeat_interval_seconds
        self.heartbeat_interval = heartbeat_s
        self.next_heartbeat_at = now()  # first heartbeat immediately
        self.next_idle_sample_at = now() + idle.SAMPLE_INTERVAL_SECONDS

        if idle_detector is not None:
            self.idle_detector = idle_detector
            self.idle_mode = "external"
        else:
            mode = idle.detect_mode()
            if mode == "none":
                log.warning(
                    "idle detection unavailable (need ioreg on macOS or "
                    "xprintidle on Linux); input_resumed signals disabled"
                )
            self.idle_mode = mode
            self.idle_detector = IdleDetector(
                store,
                idle.make_sampler(mode),
                config.return_idle_seconds,
                now=now,
            )
        store.set_state("idle_mode", self.idle_mode)

    def tick(self) -> None:
        """One loop iteration: housekeeping, drain, heartbeat, idle sample."""
        now = self.now()
        housekeeping(
            self.store, now, logged_in=bool(self.sender.key_reader())
        )
        self.sender.drain()

        heartbeat_due = now >= self.next_heartbeat_at
        loop_healthy = (
            now - self.last_tick_completed <= 3 * self.heartbeat_interval
        )
        if heartbeat_due:
            if loop_healthy:
                self.sender.heartbeat(self.store.active_runs())
            else:
                # Loop has not completed a tick in three intervals: hold
                # heartbeats so the server marks this machine silent.
                log.warning("loop stalled; skipping heartbeat")
            self.next_heartbeat_at = now + self.heartbeat_interval

        if now >= self.next_idle_sample_at:
            self.idle_detector.sample()
            self.next_idle_sample_at = now + idle.SAMPLE_INTERVAL_SECONDS

        self.last_tick_completed = self.now()

    def run(self) -> int:
        def _stop(_signum, _frame):
            self.stop_event.set()

        signal.signal(signal.SIGINT, _stop)
        signal.signal(signal.SIGTERM, _stop)
        log.info("agentwatch daemon started")
        while not self.stop_event.is_set():
            self.tick()
            self.sleep(1.0)
        # One last heartbeat on shutdown, best effort.
        try:
            self.sender.heartbeat(self.store.active_runs())
        except Exception:
            pass
        log.info("agentwatch daemon stopped")
        return 0
