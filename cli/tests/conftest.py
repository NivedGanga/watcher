"""Shared fixtures: isolated config/data dirs, fake backend, helpers."""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import pytest

CLI_ROOT = Path(__file__).resolve().parent.parent
SRC = CLI_ROOT / "src"
REPO_ROOT = CLI_ROOT.parent
SPEC_DIR = REPO_ROOT / "spec"
TESTS_DIR = Path(__file__).resolve().parent
FAKE_AGENT = TESTS_DIR / "fake_agent.py"

sys.path.insert(0, str(SRC))
sys.path.insert(0, str(TESTS_DIR))

from fake_backend import FakeBackend  # noqa: E402


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """Isolated AGENTWATCH_CONFIG_DIR / AGENTWATCH_DATA_DIR."""
    cfg = tmp_path / "config"
    data = tmp_path / "data"
    monkeypatch.setenv("AGENTWATCH_CONFIG_DIR", str(cfg))
    monkeypatch.setenv("AGENTWATCH_DATA_DIR", str(data))
    monkeypatch.delenv("AGENTWATCH_DEV", raising=False)
    monkeypatch.delenv("AGENTWATCH_BACKEND_URL", raising=False)
    monkeypatch.delenv("AGENTWATCH_RUN_ID", raising=False)
    monkeypatch.delenv("AGENTWATCH_AGENT", raising=False)
    return {"config_dir": cfg, "data_dir": data, "tmp": tmp_path}


@pytest.fixture()
def backend(env, monkeypatch):
    """Fake backend on localhost; enables dev mode + backend override."""
    be = FakeBackend()
    monkeypatch.setenv("AGENTWATCH_DEV", "1")
    monkeypatch.setenv("AGENTWATCH_BACKEND_URL", be.url)
    yield be
    be.close()


@pytest.fixture()
def store(env):
    from agentwatch.store import Store

    s = Store()
    yield s
    s.close()


@pytest.fixture()
def config(env):
    from agentwatch.config import load

    return load()


@pytest.fixture()
def logged_in(env, backend, config):
    """Write a machine key + machine_id without touching the network."""
    from agentwatch import machinekey

    machinekey.write_key("aw_m_test123_secretkey")
    config.set("general", "machine_id", "m_test123")
    config.save()
    return config


def read_outbox(env) -> list[dict]:
    db_path = env["data_dir"] / "outbox.sqlite"
    if not db_path.exists():
        return []
    db = sqlite3.connect(str(db_path))
    db.row_factory = sqlite3.Row
    try:
        rows = db.execute(
            "SELECT * FROM outbox ORDER BY created_at, rowid"
        ).fetchall()
    finally:
        db.close()
    out = []
    for r in rows:
        d = dict(r)
        d["payload"] = json.loads(d["payload"])
        out.append(d)
    return out


def outbox_events(env) -> list[dict]:
    return [
        r["payload"] for r in read_outbox(env) if r["kind"] == "event"
    ]


def outbox_signals(env) -> list[dict]:
    return [
        r["payload"] for r in read_outbox(env) if r["kind"] == "signal"
    ]


def run_cli(args: list[str], env, *, stdin=None, timeout=60, extra_env=None):
    """Run the real CLI in a subprocess (needed for `run`'s pty)."""
    full_env = dict(os.environ)
    full_env["AGENTWATCH_CONFIG_DIR"] = str(env["config_dir"])
    full_env["AGENTWATCH_DATA_DIR"] = str(env["data_dir"])
    full_env["PYTHONPATH"] = str(SRC) + os.pathsep + full_env.get(
        "PYTHONPATH", ""
    )
    if extra_env:
        full_env.update(extra_env)
    return subprocess.Popen(
        [sys.executable, "-m", "agentwatch", *args],
        stdin=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=full_env,
    )


def run_cli_blocking(args, env, *, input_text=None, timeout=60, extra_env=None):
    proc = run_cli(args, env, stdin=subprocess.PIPE, timeout=timeout,
                   extra_env=extra_env)
    out, err = proc.communicate(input=input_text, timeout=timeout)
    return proc.returncode, out.decode(), err.decode()


def wait_for(predicate, timeout=10.0, interval=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()
