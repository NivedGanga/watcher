"""Durable mobile question creation and shell-tool recovery."""
import json
import os
import signal
import sys
import time
import uuid
from datetime import datetime, timezone

import pytest

from snitch import machinekey, questions
from snitch.httpclient import ApiError, NetworkError
from snitch.redact import Redactor
from conftest import run_cli_blocking, outbox_events


@pytest.fixture
def enrolled(env, config):
    machinekey.write_key("aw_test_secret")
    config.set("general", "machine_id", "test")
    return config


def save(store, config, timeout=1800):
    payload = {"id": str(uuid.uuid4()), "agent": "agent", "host": "host", "run_id": "run",
               "prompt": "Database?", "options": [{"id": "1", "label": "SQLite"}],
               "allow_text": True, "timeout_s": timeout}
    store.save_question(payload, config.machine_id, time.time())
    return payload


def response(payload, status="pending", answer=None):
    return {"question_id": payload["id"], "status": status, "answer": answer,
            "expires_at": datetime.fromtimestamp(time.time() + 1800, timezone.utc).isoformat()}


def test_answer_survives_lost_creation_response(store, enrolled, capsys):
    payload = save(store, enrolled)
    calls = []
    sleeps = []

    def request(base, method, path, body, **kwargs):
        calls.append((method, path, body))
        assert kwargs["key"] == "aw_test_secret"
        if len(calls) == 1:
            raise NetworkError("response lost")
        return 200, response(payload, "answered", {"option_id": "1", "label": "SQLite"}), {}

    assert questions.wait(payload["id"], store, enrolled, request=request, sleep=sleeps.append) == 0
    assert [c[2]["id"] for c in calls[:2]] == [payload["id"], payload["id"]]
    assert calls[-1][1].endswith("/received")
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["answer"] == {"option_id": "1", "label": "SQLite"}
    assert store.get_question(payload["id"])["waiter_pid"] is None


def test_interrupted_wait_can_resume_same_question(store, enrolled, capsys):
    payload = save(store, enrolled)
    calls = []

    def request(base, method, path, body, **kwargs):
        calls.append(method)
        return 200, response(payload), {}

    def interrupt(_delay):
        signal.raise_signal(signal.SIGTERM)

    assert questions.wait(payload["id"], store, enrolled, request=request, sleep=interrupt) == 1
    assert json.loads(capsys.readouterr().out)["error"] == "wait_interrupted"
    assert calls == ["POST"]

    def answered(base, method, path, body, **kwargs):
        calls.append(method)
        return 200, response(payload, "answered", {"text": "Use SQLite"}), {}

    assert questions.wait(payload["id"], store, enrolled, request=answered) == 0
    assert calls == ["POST", "GET", "POST"]
    assert json.loads(capsys.readouterr().out)["answer"] == {"text": "Use SQLite"}


@pytest.mark.parametrize("status,code", [("expired", 3), ("cancelled", 4)])
def test_closed_states_are_not_answers(store, enrolled, capsys, status, code):
    payload = save(store, enrolled)
    assert questions.wait(payload["id"], store, enrolled,
                          request=lambda *a, **kw: (200, response(payload, status), {})) == code
    assert json.loads(capsys.readouterr().out)["answer"] is None


def test_offline_at_deadline_does_not_invent_expiry(store, enrolled, capsys):
    payload = save(store, enrolled, timeout=1)
    def offline(*a, **kw):
        raise NetworkError("offline")
    assert questions.wait(payload["id"], store, enrolled, now=lambda: time.time() + 2, request=offline) == 1
    assert json.loads(capsys.readouterr().out)["error"] == "network_result_unknown"


def test_metadata_sends_and_persists_nothing(store, enrolled, capsys):
    enrolled.set("general", "privacy_mode", "metadata")
    assert questions.ask("sensitive prompt", [], True, "30m", store, enrolled, Redactor()) == 1
    assert store.db.execute("SELECT COUNT(*) FROM questions").fetchone()[0] == 0
    captured = capsys.readouterr()
    assert "sensitive prompt" not in captured.out + captured.err


def test_resuming_cannot_bypass_new_metadata_privacy_setting(store, enrolled, capsys):
    payload = save(store, enrolled)
    enrolled.set("general", "privacy_mode", "metadata")
    def no_network(*a, **kw):
        pytest.fail("metadata recovery must not transmit a saved prompt")
    assert questions.wait(payload["id"], store, enrolled, request=no_network) == 1
    assert json.loads(capsys.readouterr().out)["error"] == "metadata_privacy"


def test_redaction_before_persistence_and_structured_ids(store, enrolled, monkeypatch):
    monkeypatch.setattr(questions, "wait", lambda *a: 0)
    assert questions.ask("Use private-value?", ["private-value", "Other"], False, "30m",
                         store, enrolled, Redactor(["private-value"])) == 0
    row = store.db.execute("SELECT * FROM questions").fetchone()
    assert "private-value" not in row["request"]
    data = json.loads(row["request"])
    assert data["options"] == [{"id": "1", "label": "[REDACTED]"}, {"id": "2", "label": "Other"}]
    assert data["timeout_s"] == 1800


def test_mobile_waiter_survives_legacy_output_close(store, enrolled):
    payload = save(store, enrolled)
    store.set_question_waiter(payload["id"], os.getpid())
    store.start_run("run", "agent", os.getpid(), time.time())
    store.open_question("run", time.time())
    store.close_question("run")
    assert store.question_open("run")
    store.update_question(payload["id"], "answered", time.time() + 1800)
    assert not store.question_open("run")


def test_auth_and_invalid_server_responses_are_json_failures(store, enrolled, capsys):
    payload = save(store, enrolled)
    def unauthorized(*a, **kw):
        raise ApiError(401, "unauthorized")
    assert questions.wait(payload["id"], store, enrolled, request=unauthorized) == 1
    assert json.loads(capsys.readouterr().out)["error"] == "unauthorized"
    bad = response(payload)
    del bad["expires_at"]
    assert questions.wait(payload["id"], store, enrolled, request=lambda *a, **kw: (200, bad, {})) == 1
    assert json.loads(capsys.readouterr().out)["error"] == "invalid_server_response"


def test_wrapper_does_not_stall_or_close_mobile_question_after_output(env):
    script = """
import os, time, uuid
from snitch.store import Store
s = Store()
qid = str(uuid.uuid4())
s.save_question({'id':qid,'run_id':os.environ['SNITCH_RUN_ID'],'timeout_s':30}, 'test', time.time())
s.set_question_waiter(qid, os.getpid())
print('Waiting', flush=True)
time.sleep(1.2)
print('Background progress', flush=True)
time.sleep(1.2)
assert s.question_open(os.environ['SNITCH_RUN_ID'])
"""
    rc, _, err = run_cli_blocking(['run', '--name', 'demo', '--stall', '1s', '--timeout', '10s',
                                  '--', sys.executable, '-c', script], env)
    assert rc == 0, err
    assert [e['type'] for e in outbox_events(env)] == ['done']
