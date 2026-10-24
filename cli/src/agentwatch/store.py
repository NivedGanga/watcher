"""Local durable state: the outbox, the runs table, and key/value state.

SQLite in WAL mode at ``~/.local/share/agentwatch/outbox.sqlite``. The CLI
writes locally first and sends later, so events survive restarts and network
outages.
"""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from pathlib import Path

from . import paths

SCHEMA = """
CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('event', 'signal')),
    payload TEXT NOT NULL,
    created_at REAL NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'dead')),
    last_error_category TEXT
);
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    pid INTEGER,
    started_at REAL NOT NULL,
    ended_at REAL,
    question_open_at REAL
);
CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

SENT_RETENTION_SECONDS = 24 * 3600
LOGGED_OUT_DROP_SECONDS = 7 * 24 * 3600


def pid_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


class Store:
    def __init__(self, path: Path | None = None):
        self.path = path or paths.outbox_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path), timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # -- outbox -----------------------------------------------------------
    def enqueue(self, kind: str, payload: dict, now: float) -> str:
        row_id = payload.get("id") or str(uuid.uuid4())
        payload["id"] = row_id
        self.db.execute(
            "INSERT INTO outbox (id, kind, payload, created_at) "
            "VALUES (?, ?, ?, ?)",
            (row_id, kind, json.dumps(payload), now),
        )
        self.db.commit()
        return row_id

    def due_rows(self, kind: str, now: float, limit: int = 50) -> list[sqlite3.Row]:
        return list(
            self.db.execute(
                "SELECT * FROM outbox WHERE status = 'pending' AND kind = ? "
                "AND next_attempt_at <= ? ORDER BY created_at LIMIT ?",
                (kind, now, limit),
            )
        )

    def due_count(self, now: float) -> int:
        (n,) = self.db.execute(
            "SELECT COUNT(*) FROM outbox WHERE status = 'pending' "
            "AND next_attempt_at <= ?",
            (now,),
        ).fetchone()
        return n

    def has_pending(self) -> bool:
        (n,) = self.db.execute(
            "SELECT COUNT(*) FROM outbox WHERE status = 'pending'"
        ).fetchone()
        return n > 0

    def mark_sent(self, ids: list[str]) -> None:
        self.db.executemany(
            "UPDATE outbox SET status = 'sent', last_error_category = NULL "
            "WHERE id = ?",
            [(i,) for i in ids],
        )
        self.db.commit()

    def mark_dead(self, ids: list[str], category: str | None) -> None:
        self.db.executemany(
            "UPDATE outbox SET status = 'dead', last_error_category = ? "
            "WHERE id = ?",
            [(category, i) for i in ids],
        )
        self.db.commit()

    def note_failure(
        self, ids: list[str], category: str, next_attempt_at: float
    ) -> None:
        self.db.executemany(
            "UPDATE outbox SET attempts = attempts + 1, "
            "next_attempt_at = ?, last_error_category = ? WHERE id = ?",
            [(next_attempt_at, category, i) for i in ids],
        )
        self.db.commit()

    def retry_after(self, ids: list[str], when: float) -> None:
        self.db.executemany(
            "UPDATE outbox SET next_attempt_at = ?, "
            "last_error_category = 'rate_limited' WHERE id = ?",
            [(when, i) for i in ids],
        )
        self.db.commit()

    def counts_by_status(self) -> dict[str, int]:
        rows = self.db.execute(
            "SELECT status, COUNT(*) AS n FROM outbox GROUP BY status"
        ).fetchall()
        return {r["status"]: r["n"] for r in rows}

    def oldest_pending_created_at(self) -> float | None:
        row = self.db.execute(
            "SELECT MIN(created_at) FROM outbox WHERE status = 'pending'"
        ).fetchone()
        return row[0]

    def delete_sent_older_than(self, cutoff: float) -> int:
        cur = self.db.execute(
            "DELETE FROM outbox WHERE status = 'sent' AND created_at < ?",
            (cutoff,),
        )
        self.db.commit()
        return cur.rowcount

    def drop_pending_older_than(self, cutoff: float) -> int:
        """Drop pending rows older than cutoff; returns how many."""
        cur = self.db.execute(
            "DELETE FROM outbox WHERE status = 'pending' AND created_at < ?",
            (cutoff,),
        )
        self.db.commit()
        return cur.rowcount

    # -- runs ---------------------------------------------------------------
    def start_run(self, run_id: str, agent: str, pid: int, now: float) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO runs (run_id, agent, pid, started_at) "
            "VALUES (?, ?, ?, ?)",
            (run_id, agent, pid, now),
        )
        self.db.commit()

    def end_run(self, run_id: str, now: float) -> None:
        self.db.execute(
            "UPDATE runs SET ended_at = ? WHERE run_id = ?", (now, run_id)
        )
        self.db.commit()

    def get_run(self, run_id: str) -> sqlite3.Row | None:
        return self.db.execute(
            "SELECT * FROM runs WHERE run_id = ?", (run_id,)
        ).fetchone()

    def open_question(self, run_id: str, now: float) -> None:
        self.db.execute(
            "UPDATE runs SET question_open_at = ? WHERE run_id = ?",
            (now, run_id),
        )
        self.db.commit()

    def close_question(self, run_id: str) -> None:
        self.db.execute(
            "UPDATE runs SET question_open_at = NULL WHERE run_id = ?",
            (run_id,),
        )
        self.db.commit()

    def question_open(self, run_id: str) -> bool:
        row = self.db.execute(
            "SELECT question_open_at FROM runs WHERE run_id = ?", (run_id,)
        ).fetchone()
        return bool(row and row["question_open_at"])

    def active_runs(self) -> int:
        rows = self.db.execute(
            "SELECT pid FROM runs WHERE ended_at IS NULL"
        ).fetchall()
        return sum(1 for r in rows if pid_alive(r["pid"]))

    # -- state ---------------------------------------------------------------
    def get_state(self, key: str, default: str | None = None) -> str | None:
        row = self.db.execute(
            "SELECT value FROM state WHERE key = ?", (key,)
        ).fetchone()
        return row["value"] if row else default

    def set_state(self, key: str, value: str) -> None:
        self.db.execute(
            "INSERT INTO state (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        self.db.commit()
