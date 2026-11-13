"""install-service / uninstall-service on both platforms (mocked paths)."""


import pytest

from snitch import service


@pytest.fixture()
def fake_home(tmp_path, monkeypatch):
    monkeypatch.setattr(service.Path, "home", lambda: tmp_path)
    monkeypatch.setattr(service.os, "getuid", lambda: 1000, raising=False)
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    return tmp_path


def test_install_macos_writes_plist(fake_home):
    lines = service.install(platform="darwin", executable="/usr/local/bin/snitch")
    plist = fake_home / "Library/LaunchAgents/com.snitch.daemon.plist"
    assert plist.exists()
    content = plist.read_text()
    assert "com.snitch.daemon" in content
    assert "/usr/local/bin/snitch" in content
    assert "<string>daemon</string>" in content
    text = "\n".join(lines)
    assert "launchctl bootstrap" in text  # start commands printed
    assert service.is_installed("darwin")


def test_install_linux_writes_unit(fake_home):
    lines = service.install(platform="linux", executable="/opt/venvs/aw/bin/snitch")
    unit = fake_home / ".config/systemd/user/snitch.service"
    assert unit.exists()
    content = unit.read_text()
    assert "ExecStart=/opt/venvs/aw/bin/snitch daemon" in content
    text = "\n".join(lines)
    assert "systemctl --user enable --now snitch.service" in text
    assert service.is_installed("linux")


def test_uninstall_removes_unit(fake_home):
    service.install(platform="linux", executable="/x/snitch")
    lines = service.uninstall(platform="linux")
    assert not service.is_installed("linux")
    assert "disable --now" in "\n".join(lines)


def test_uninstall_when_not_installed(fake_home):
    lines = service.uninstall(platform="darwin")
    assert "No service installed" in lines[0]


@pytest.mark.parametrize("platform,relative_path", [
    ("darwin", "Library/LaunchAgents/com.agentwatch.daemon.plist"),
    ("linux", ".config/systemd/user/agentwatch.service"),
])
def test_upgrade_reuses_legacy_service(fake_home, platform, relative_path):
    legacy = fake_home / relative_path
    legacy.parent.mkdir(parents=True)
    legacy.write_text("old service")
    assert service.is_installed(platform)
    lines = "\n".join(service.install(platform=platform, executable="/usr/local/bin/snitch"))
    assert service.service_path(platform) == legacy
    assert "/usr/local/bin/snitch" in legacy.read_text()
    if platform == "darwin":
        assert "<string>com.agentwatch.daemon</string>" in legacy.read_text()
        assert "launchctl bootout" in lines
    else:
        assert "systemctl --user restart agentwatch.service" in lines
    service.uninstall(platform)
    assert not legacy.exists()
