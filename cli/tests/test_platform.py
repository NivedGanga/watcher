"""Unsupported-platform behavior (mocked)."""

import sys

from agentwatch import cli, paths


def test_windows_exits_2(monkeypatch, capsys):
    monkeypatch.setattr(sys, "platform", "win32")
    rc = cli.main(["status"])
    assert rc == 2
    err = capsys.readouterr().err
    assert (
        "AgentWatch supports macOS and Linux (WSL included) in this version."
        in err
    )


def test_supported_platforms(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    assert paths.platform_supported()
    monkeypatch.setattr(sys, "platform", "linux")
    assert paths.platform_supported()
