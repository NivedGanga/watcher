"""login / logout against the fake backend."""

import os
import stat


from agentwatch import machinekey
from agentwatch.enroll import login, logout


def _run_login(config, store, **kw):
    out_lines, err_lines, sleeps = [], [], []
    kwargs = dict(
        out=out_lines.append,
        err=err_lines.append,
        input_fn=lambda prompt: "n\n",
        sleep=lambda s: sleeps.append(s),
        open_browser=lambda url: None,
        no_service=True,
    )
    kwargs.update(kw)
    rc = login(config, store, **kwargs)
    return rc, out_lines, err_lines, sleeps


def test_login_happy_path(env, store, backend, config):
    backend.token_responses = [
        ("error", "authorization_pending"),
        ("error", "slow_down"),
        ("error", "authorization_pending"),
    ]
    rc, out, err, sleeps = _run_login(config, store)
    assert rc == 0
    # slow_down bumped the interval by 5s at least once.
    assert 10.0 in sleeps
    # user_code shown, approval message shown.
    text = "\n".join(out)
    assert "XKCD-9W2P" in text
    assert "Approve this code in your browser" in text
    # Key written, machine_id recorded, key never printed.
    key_path = env["config_dir"] / "machine.key"
    assert key_path.exists()
    secret = key_path.read_text()
    assert secret not in text + "\n".join(err)
    assert "m_test123" in text  # machine_id is ok to show
    # Test email attempted (non-fatal anyway).
    assert backend.test_emails == 1


def test_login_key_mode_0600_restrictive_umask(env, store, backend, config):
    env["config_dir"].mkdir(parents=True, exist_ok=True)
    old = os.umask(0o777)
    try:
        rc, *_ = _run_login(config, store)
    finally:
        os.umask(old)
    assert rc == 0
    mode = stat.S_IMODE(os.stat(env["config_dir"] / "machine.key").st_mode)
    assert mode == 0o600


def test_login_second_time_refused(env, store, backend, config):
    rc, *_ = _run_login(config, store)
    assert rc == 0
    rc2, out, err, _ = _run_login(config, store)
    assert rc2 == 1
    assert "Already logged in. Run agentwatch logout first." in "\n".join(err)


def test_login_expired_token(env, store, backend, config):
    backend.token_responses = [("error", "expired_token")]
    rc, out, err, _ = _run_login(config, store)
    assert rc == 1
    assert "The code expired. Run agentwatch login again." in "\n".join(err)
    assert not (env["config_dir"] / "machine.key").exists()


def test_login_access_denied(env, store, backend, config):
    backend.token_responses = [("error", "access_denied")]
    rc, out, err, _ = _run_login(config, store)
    assert rc == 1
    assert "The request was denied in the browser." in "\n".join(err)


def test_login_ctrl_c_cancels_without_network(env, store, backend, config):
    def boom(_seconds):
        raise KeyboardInterrupt

    rc, out, err, _ = _run_login(config, store, sleep=boom)
    assert rc == 130
    assert backend.token_polls == 0  # cancelled before any token call


def test_login_opens_browser_unless_disabled(env, store, backend, config):
    opened = []
    rc, *_ = _run_login(config, store, open_browser=opened.append,
                        no_browser=False)
    assert rc == 0 and opened


def test_login_offers_service_install(env, store, backend, config,
                                      monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    rc, out, err, _ = _run_login(
        config, store, no_service=False, input_fn=lambda p: "y\n"
    )
    assert rc == 0
    plist = (
        tmp_path / "Library/LaunchAgents/com.agentwatch.daemon.plist"
    )
    import sys

    if sys.platform == "darwin":
        assert plist.exists()
    else:
        assert (
            tmp_path / ".config/systemd/user/agentwatch.service"
        ).exists()


def test_login_yes_flag_accepts_service(env, store, backend, config,
                                        monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    prompts = []

    def fail_prompt(_p):
        prompts.append(1)
        raise AssertionError("should not prompt with --yes")

    rc, *_ = _run_login(
        config, store, no_service=False, yes=True, input_fn=fail_prompt
    )
    assert rc == 0 and not prompts


def test_key_mode_wrong_refuses(env):
    path = machinekey.write_key("aw_x_y")
    os.chmod(path, 0o644)
    problem = machinekey.permission_error()
    assert "chmod 600" in problem


def test_logout_revokes(env, store, backend, logged_in):
    rc = logout(logged_in, store, out=lambda s: None)
    assert rc == 0
    assert backend.deleted_machines == 1
    assert not (env["config_dir"] / "machine.key").exists()
    from agentwatch.config import load

    assert load().machine_id == ""


def test_logout_removes_key_even_when_request_fails(
    env, store, backend, logged_in
):
    backend.delete_status = 500
    lines = []
    rc = logout(logged_in, store, out=lines.append)
    assert rc == 0
    assert not (env["config_dir"] / "machine.key").exists()
    assert "did not confirm revocation" in " ".join(lines)


def test_logout_not_logged_in(env, store, config, capsys=None):
    lines = []
    rc = logout(config, store, out=lines.append)
    assert rc == 0
    assert "Not logged in." in " ".join(lines)
