"""Drain the outbox to the server, send heartbeats, prune old rows."""

from __future__ import annotations

import json
import logging
import random
import time
from dataclasses import dataclass, field

from . import events, machinekey
from .httpclient import ApiError, NetworkError, api_request
from .store import LOGGED_OUT_DROP_SECONDS, SENT_RETENTION_SECONDS, Store

log = logging.getLogger("agentwatch.delivery")

BATCH_SIZE = 50
BACKOFF_BASE_SECONDS = 5.0
BACKOFF_CAP_SECONDS = 3600.0
DEFAULT_RETRY_AFTER = 60.0

UPGRADE_MESSAGE = (
    "This agentwatch is too old for the server. "
    "Run: pipx upgrade agentwatch"
)
AUTH_REJECTED_MESSAGE = (
    "machine key rejected; run agentwatch logout, then agentwatch login"
)


@dataclass
class DrainReport:
    results: dict[str, str] = field(default_factory=dict)
    blocked: str | None = None
    attempted: int = 0
    sent: int = 0


def backoff_delay(attempts: int, rand: float | None = None) -> float:
    base = min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * (2**attempts))
    jitter = rand if rand is not None else random.uniform(0.5, 1.5)
    return min(BACKOFF_CAP_SECONDS, base * jitter)


def housekeeping(store: Store, now: float, logged_in: bool) -> int:
    """Delete old sent rows; when logged out, drop pending rows older than
    7 days and add them to dropped_unsent_count. Returns dropped count."""
    store.delete_sent_older_than(now - SENT_RETENTION_SECONDS)
    dropped = 0
    if not logged_in:
        dropped = store.drop_pending_older_than(now - LOGGED_OUT_DROP_SECONDS)
        if dropped:
            prev = int(store.get_state("dropped_unsent_count", "0") or 0)
            store.set_state("dropped_unsent_count", str(prev + dropped))
            log.info("dropped %d events queued while logged out", dropped)
    return dropped


class Sender:
    def __init__(
        self,
        store: Store,
        config,
        *,
        now=time.time,
        rand=None,
        request=api_request,
        key_reader=machinekey.read_key,
    ):
        self.store = store
        self.config = config
        self.now = now
        self.rand = rand
        self.request = request
        self.key_reader = key_reader

    # -- helpers -----------------------------------------------------------
    def _blocked(self) -> str | None:
        return self.store.get_state("send_blocked")

    def _set_blocked(self, reason: str | None) -> None:
        if reason:
            self.store.set_state("send_blocked", reason)
        else:
            self.store.db.execute("DELETE FROM state WHERE key = 'send_blocked'")
            self.store.db.commit()

    @staticmethod
    def clear_blocked(store: Store) -> None:
        store.db.execute("DELETE FROM state WHERE key = 'send_blocked'")
        store.db.commit()

    # -- sending ------------------------------------------------------------
    def _post_batch(self, kind: str, rows) -> DrainReport:
        report = DrainReport()
        ids = [r["id"] for r in rows]
        payloads = [json.loads(r["payload"]) for r in rows]
        path = "/api/events" if kind == "event" else "/api/signals"
        body_key = "events" if kind == "event" else "signals"
        key = self.key_reader()
        try:
            status, data, _ = self.request(
                self.config.backend_url,
                "POST",
                path,
                body={body_key: payloads},
                key=key,
            )
        except ApiError as exc:
            self._handle_api_error(exc, ids, report)
            return report
        except NetworkError as exc:
            self._handle_network_failure(ids, report, str(exc))
            return report

        results = (data or {}).get("results", [])
        by_id = {}
        for res in results:
            if isinstance(res, dict) and "id" in res:
                by_id[res["id"]] = res
        sent, dead = [], []
        for row_id, payload in zip(ids, payloads):
            res = by_id.get(row_id, {})
            rstatus = res.get("status", "accepted")
            report.results[row_id] = rstatus
            if rstatus in ("accepted", "duplicate"):
                sent.append(row_id)
            else:
                dead.append(row_id)
                log.warning(
                    "event %s rejected: %s", row_id, res.get("reason", "?")
                )
        if sent:
            self.store.mark_sent(sent)
        if dead:
            self.store.mark_dead(dead, "rejected")
        report.sent += len(sent)
        if status == 202 or 200 <= status < 300:
            self.store.set_state("last_send_at", f"{self.now():.3f}")
        return report

    def _handle_api_error(self, exc: ApiError, ids, report: DrainReport) -> None:
        if exc.status == 401:
            self._set_blocked("unauthorized")
            report.blocked = "unauthorized"
            log.error(AUTH_REJECTED_MESSAGE)
            return
        if exc.status == 426:
            self._set_blocked("upgrade_required")
            report.blocked = "upgrade_required"
            log.error(UPGRADE_MESSAGE)
            return
        if exc.status == 429:
            delay = exc.retry_after if exc.retry_after is not None else (
                DEFAULT_RETRY_AFTER
            )
            self.store.retry_after(ids, self.now() + delay)
            for i in ids:
                report.results[i] = "rate_limited"
            log.warning("rate limited; retrying in %.0fs", delay)
            return
        if exc.status >= 500:
            self._handle_network_failure(ids, report, f"HTTP {exc.status}")
            return
        # Other 4xx: mark the batch dead and log the category.
        self.store.mark_dead(ids, exc.code)
        for i in ids:
            report.results[i] = "dead"
        log.error("batch marked dead: %s %s", exc.status, exc.code)

    def _handle_network_failure(self, ids, report: DrainReport, why: str) -> None:
        delay = backoff_delay(1, self.rand() if self.rand else None)
        self.store.note_failure(ids, "network", self.now() + delay)
        for i in ids:
            report.results[i] = "retry_scheduled"
        log.warning("send failed (%s); retry in %.0fs", why, delay)

    def drain(self) -> DrainReport:
        """Send every due batch of events and signals."""
        report = DrainReport()
        blocked = self._blocked()
        if blocked:
            report.blocked = blocked
            return report
        if not self.key_reader():
            housekeeping(self.store, self.now(), logged_in=False)
            return report

        for kind in ("event", "signal"):
            while True:
                rows = self.store.due_rows(kind, self.now(), BATCH_SIZE)
                if not rows:
                    break
                report.attempted += len(rows)
                sub = self._post_batch(kind, rows)
                report.results.update(sub.results)
                report.sent += sub.sent
                if sub.blocked:
                    report.blocked = sub.blocked
                    return report
                # Stop looping if nothing was resolved (all deferred).
                if not sub.sent and not any(
                    v == "dead" for v in sub.results.values()
                ):
                    break
        housekeeping(self.store, self.now(), logged_in=True)
        return report

    def heartbeat(self, active_runs: int) -> bool:
        """POST /api/heartbeat. Returns True on success."""
        if self._blocked():
            return False
        key = self.key_reader()
        if not key:
            return False
        body = {
            "sent_at": events.now_rfc3339(),
            "active_runs": int(active_runs),
        }
        try:
            self.request(
                self.config.backend_url, "POST", "/api/heartbeat", body=body, key=key
            )
        except ApiError as exc:
            if exc.status == 401:
                self._set_blocked("unauthorized")
                log.error(AUTH_REJECTED_MESSAGE)
            elif exc.status == 426:
                self._set_blocked("upgrade_required")
                log.error(UPGRADE_MESSAGE)
            else:
                log.warning("heartbeat failed: HTTP %s %s", exc.status, exc.code)
            return False
        except NetworkError as exc:
            log.warning("heartbeat failed: %s", exc)
            return False
        self.store.set_state("last_heartbeat_at", f"{self.now():.3f}")
        return True
