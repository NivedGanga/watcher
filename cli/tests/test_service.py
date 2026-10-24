"""install-service / uninstall-service on both platforms (mocked paths)."""


import pytest

from agentwatch import service


@pytest.fixture()
def fake_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    return tmp_path


def test_install_macos_writes_plist(fake_home):
    lines = service.install(platform="darwin", executable="/usr/local/bin/agentwatch")
    plist = fake_home / "Library/LaunchAgents/com.agentwatch.daemon.plist"
    assert plist.exists()
    content = plist.read_text()
    assert "com.agentwatch.daemon" in content
    assert "/usr/local/bin/agentwatch" in content
    assert "<string>daemon</string>" in content
    text = "\n".join(lines)
    assert "launchctl bootstrap" in text  # start commands printed
    assert service.is_installed("darwin")


def test_install_linux_writes_unit(fake_home):
    lines = service.install(platform="linux", executable="/opt/venvs/aw/bin/agentwatch")
    unit = fake_home / ".config/systemd/user/agentwatch.service"
    assert unit.exists()
    content = unit.read_text()
    assert "ExecStart=/opt/venvs/aw/bin/agentwatch daemon" in content
    text = "\n".join(lines)
    assert "systemctl --user enable --now agentwatch.service" in text
    assert service.is_installed("linux")


def test_uninstall_removes_unit(fake_home):
    service.install(platform="linux", executable="/x/agentwatch")
    lines = service.uninstall(platform="linux")
    assert not service.is_installed("linux")
    assert "disable --now" in "\n".join(lines)


def test_uninstall_when_not_installed(fake_home):
    lines = service.uninstall(platform="darwin")
    assert "No service installed" in lines[0]
