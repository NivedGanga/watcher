"""Upgrades preserve local state and respect old and new environment names."""

import pytest

from snitch import commands, paths
from snitch.config import dev_mode, load


@pytest.mark.parametrize("kind,xdg_name,relative", [
    ("config", "XDG_CONFIG_HOME", ".config"),
    ("data", "XDG_DATA_HOME", ".local/share"),
])
def test_paths_reuse_legacy_state_until_new_location_exists(tmp_path, monkeypatch, kind, xdg_name, relative):
    monkeypatch.setattr(paths.sys, "platform", "linux")
    monkeypatch.setattr(paths.Path, "home", lambda: tmp_path)
    monkeypatch.delenv(xdg_name, raising=False)
    monkeypatch.delenv(f"SNITCH_{kind.upper()}_DIR", raising=False)
    monkeypatch.delenv(f"AGENTWATCH_{kind.upper()}_DIR", raising=False)
    locate = paths.config_dir if kind == "config" else paths.data_dir
    base = tmp_path / relative
    assert locate() == base / "snitch"
    legacy = base / "agentwatch"
    legacy.mkdir(parents=True)
    (legacy / "state").write_text("keep")
    assert locate() == legacy
    (base / "snitch").mkdir()
    assert locate() == base / "snitch"
    assert (legacy / "state").read_text() == "keep"


def test_environment_uses_new_names_with_legacy_fallback(tmp_path, monkeypatch):
    monkeypatch.delenv("SNITCH_CONFIG_DIR", raising=False)
    monkeypatch.setenv("AGENTWATCH_CONFIG_DIR", str(tmp_path / "old"))
    assert paths.config_dir() == tmp_path / "old"
    monkeypatch.setenv("SNITCH_CONFIG_DIR", str(tmp_path / "new"))
    assert paths.config_dir() == tmp_path / "new"


def test_legacy_dev_settings_and_run_identity(env, monkeypatch):
    monkeypatch.setenv("AGENTWATCH_DEV", "1")
    monkeypatch.setenv("AGENTWATCH_BACKEND_URL", "http://127.0.0.1:9999")
    monkeypatch.setenv("AGENTWATCH_AGENT", "legacy-agent")
    monkeypatch.setenv("AGENTWATCH_RUN_ID", "legacy-run")
    assert dev_mode()
    config = load()
    assert config.backend_url == "http://127.0.0.1:9999"
    assert commands._run_identity(config) == ("legacy-agent", "legacy-run")
    monkeypatch.setenv("SNITCH_DEV", "0")
    assert not dev_mode()
    assert config.backend_url.startswith("https://")
