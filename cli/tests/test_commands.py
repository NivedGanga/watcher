"""privacy, status, and test commands."""



from agentwatch import commands, events
from agentwatch.config import load
from agentwatch.redact import Redactor
from conftest import outbox_events, run_cli_blocking


def test_privacy_show_and_set(env, config):
    lines = []
    assert commands.cmd_privacy(None, config, out=lines.append) == 0
    assert "Privacy mode: full" in lines[0]
    assert any("metadata" in l for l in lines)
    # Explanations describe exactly what leaves the machine.
    text = "\n".join(lines)
    assert "summary" in text and "never sent" in text

    lines2 = []
    commands.cmd_privacy("metadata", config, out=lines2.append)
    assert load().privacy_mode == "metadata"


def test_status_fields(env, store, config):
    lines = []
    commands.cmd_status(config, store, out=lines.append)
    text = "\n".join(lines)
    for needle in (
        "Logged in:",
        "Backend:",
        "Machine ID:",
        "Outbox:",
        "Last successful send:",
        "Last heartbeat:",
        "Idle detection:",
        "Privacy mode:",
        "Service installed:",
    ):
        assert needle in text


def test_status_waiting_for_login(env, store, config):
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
    lines = []
    commands.cmd_status(config, store, out=lines.append)
    assert any("Waiting for login: 1 event" in l for l in lines)


def test_test_command_sends_each_type(env, store, backend, logged_in):
    out = []
    rc = commands.cmd_test(logged_in, store, Redactor(), out=out.append)
    assert rc == 0
    assert len(backend.events_received) == 5
    types = {e["type"] for e in backend.events_received}
    assert types == {"question", "done", "failed", "timed_out", "stalled"}
    for e in backend.events_received:
        assert e["run_id"].startswith("test-")
    assert all("accepted" in l for l in out)


def test_test_command_requires_login(env, store, config):
    errs = []
    rc = commands.cmd_test(config, store, Redactor(), err=errs.append)
    assert rc == 1
    assert "Not logged in" in errs[0]


def test_ask_done_no_network_without_login(env):
    """ask/done work fully offline — they only write locally."""
    rc, out, err = run_cli_blocking(["ask", "q?"], env)
    assert rc == 0
    rc, out, err = run_cli_blocking(["done", "finished it"], env)
    assert rc == 0
    types = [e["type"] for e in outbox_events(env)]
    assert types == ["question", "done"]


def test_ask_inside_run_uses_env_identity(env):
    rc, _, _ = run_cli_blocking(
        ["ask", "continue?"],
        env,
        extra_env={
            "AGENTWATCH_RUN_ID": "run-abc",
            "AGENTWATCH_AGENT": "myagent",
        },
    )
    assert rc == 0
    (e,) = outbox_events(env)
    assert e["run_id"] == "run-abc"
    assert e["agent"] == "myagent"


def test_status_via_cli(env):
    rc, out, err = run_cli_blocking(["status"], env)
    assert rc == 0
    assert "Logged in:" in out
