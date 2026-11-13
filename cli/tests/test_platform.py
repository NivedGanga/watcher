"""Windows paths and native CLI support."""

import sys

import pytest

from snitch import cli, idle, machinekey, paths, service


def test_windows_defaults(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    for prefix in ("SNITCH", "AGENTWATCH"):
        for kind in ("CONFIG", "DATA"):
            monkeypatch.delenv(f"{prefix}_{kind}_DIR", raising=False)
    assert paths.client_os() == "windows"
    assert paths.config_dir() == paths.data_dir() == tmp_path / "snitch"
    assert idle.detect_mode() == "win32"
    assert not service.is_installed()


@pytest.mark.skipif(sys.platform != "win32", reason="Requires Windows DPAPI")
def test_windows_machine_key_is_protected(env):
    secret = "aw_test_machine_secret"
    key = machinekey.write_key(secret)
    assert secret.encode() not in key.read_bytes()
    assert machinekey.read_key() == secret
    assert machinekey.permission_error() is None
    key.write_bytes(b"corrupt")
    assert machinekey.read_key() is None
    assert machinekey.permission_error()


@pytest.mark.skipif(sys.platform != "win32", reason="Requires native Windows")
def test_windows_service_points_to_daemon(env, capsys):
    assert cli.main(["status"]) == 0
    assert cli.main(["install-service"]) == 2
    assert "snitch daemon" in capsys.readouterr().err
