"""One test per redaction.json pattern + env-value redaction.

Each fake secret must appear in no outbox row and no request body.
"""

import json

import pytest

from agentwatch import events
from agentwatch.redact import Redactor, load_patterns

from conftest import read_outbox

SECRETS = [
    ("anthropic_key", "sk-ant-" + "a1B2" * 10),
    ("generic_sk_key", "sk-" + "x9Yz" * 10),
    ("github_token", "ghp_" + "Ab1" * 12),
    ("github_token", "github_pat_" + "Zz9" * 10),
    ("aws_access_key", "AKIA" + "A" * 16),
    ("bearer_token", "Bearer abcdef123456"),
    (
        "jwt",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
    ),
    ("assignment", "password=hunter2"),
    ("assignment", "api_key: ZZ9xsecretvalue"),
]


@pytest.mark.parametrize("name,secret", SECRETS, ids=[s for s, _ in SECRETS])
def test_pattern_redacts_everywhere(env, store, config, name, secret):
    """The secret must not survive into the outbox, in any field."""
    redactor = Redactor()
    events.enqueue_event(
        store,
        event_type="failed",
        agent=f"agent-{secret}",
        run_id="r1",
        host=f"host-{secret}",
        summary=f"failed because {secret} was wrong",
        exit_code=1,
        duration_s=1.0,
        email_allowed=True,
        redactor=redactor,
        privacy_mode="full",
    )
    for row in read_outbox(env):
        raw = json.dumps(row["payload"])
        assert secret not in raw, f"{name} leaked into {raw}"


@pytest.mark.parametrize("name,secret", SECRETS[:8], ids=[s for s, _ in SECRETS[:8]])
def test_pattern_in_request_body(env, store, backend, logged_in, name, secret):
    """The secret must not appear in what gets POSTed either."""
    from agentwatch.delivery import Sender

    redactor = Redactor()
    events.enqueue_event(
        store,
        event_type="done",
        agent="a1",
        run_id="r1",
        host=logged_in.host_name,
        summary=f"done with {secret}",
        exit_code=0,
        duration_s=1.0,
        email_allowed=True,
        redactor=redactor,
        privacy_mode="full",
    )
    Sender(store, logged_in).drain()
    for body in backend.events_received:
        assert secret not in json.dumps(body)


def test_env_value_redaction(env, store, config, monkeypatch):
    monkeypatch.setenv("MY_SECRET_TOKEN", "sup3rsecretvalue!")
    config.set("general", "redact_env", ["MY_SECRET_TOKEN"])
    redactor = Redactor.from_config(config)
    out = redactor.redact("the token sup3rsecretvalue! was used")
    assert "sup3rsecretvalue!" not in out
    assert "[REDACTED]" in out


def test_env_value_redacted_in_outbox(env, store, config, monkeypatch):
    monkeypatch.setenv("MY_SECRET_TOKEN", "tok-abc-999")
    config.set("general", "redact_env", ["MY_SECRET_TOKEN"])
    redactor = Redactor.from_config(config)
    events.enqueue_event(
        store,
        event_type="question",
        agent="a1",
        run_id="r1",
        host=config.host_name,
        summary="deploy with tok-abc-999 ?",
        exit_code=None,
        duration_s=None,
        email_allowed=True,
        redactor=redactor,
    )
    for row in read_outbox(env):
        assert "tok-abc-999" not in json.dumps(row["payload"])


def test_all_spec_patterns_have_tests():
    """Guard: every pattern name in redaction.json is exercised."""
    names = {r["name"] for r in load_patterns()}
    tested = {name for name, _ in SECRETS}
    assert names <= tested
