"""Config loading, validation, duration parsing, sanitizing."""


import pytest

from agentwatch.config import (
    ConfigError,
    load,
    parse_duration,
    sanitize_hostname,
)


def test_defaults(env, config):
    assert config.backend_url == "https://api.alerts.example.com"
    assert config.privacy_mode == "full"
    assert config.machine_id == ""
    assert config.heartbeat_interval_seconds == 300
    assert config.return_idle_seconds == 300
    assert config.host_name


def test_parse_duration():
    assert parse_duration("2h") == 7200
    assert parse_duration("15m") == 900
    assert parse_duration("300s") == 300
    assert parse_duration("90") == 90
    assert parse_duration("1h30m") == 5400
    assert parse_duration("1d") == 86400
    with pytest.raises(ValueError):
        parse_duration("abc")
    with pytest.raises(ValueError):
        parse_duration("")


def test_sanitize_hostname():
    assert sanitize_hostname("My-Laptop.local") == "my-laptop"
    assert sanitize_hostname("weird host!") == "weird-host"
    assert sanitize_hostname("") == "machine"


def test_backend_url_must_be_https(env, monkeypatch):
    cfg_path = env["config_dir"] / "config.toml"
    env["config_dir"].mkdir(parents=True)
    cfg_path.write_text(
        '[general]\nbackend_url = "http://evil.example.com"\n'
    )
    with pytest.raises(ConfigError):
        load(cfg_path)


def test_backend_url_localhost_allowed_in_dev(env, monkeypatch):
    monkeypatch.setenv("AGENTWATCH_DEV", "1")
    cfg_path = env["config_dir"] / "config.toml"
    env["config_dir"].mkdir(parents=True)
    cfg_path.write_text(
        '[general]\nbackend_url = "http://127.0.0.1:9999"\n'
    )
    cfg = load(cfg_path)
    assert cfg.backend_url == "http://127.0.0.1:9999"


def test_backend_url_localhost_rejected_without_dev(env):
    cfg_path = env["config_dir"] / "config.toml"
    env["config_dir"].mkdir(parents=True)
    cfg_path.write_text(
        '[general]\nbackend_url = "http://localhost:9999"\n'
    )
    with pytest.raises(ConfigError):
        load(cfg_path)


def test_backend_url_env_override_only_in_dev(env, monkeypatch):
    cfg_path = env["config_dir"] / "config.toml"
    env["config_dir"].mkdir(parents=True)
    cfg_path.write_text(
        '[general]\nbackend_url = "https://api.alerts.example.com"\n'
    )
    monkeypatch.setenv("AGENTWATCH_BACKEND_URL", "http://127.0.0.1:1")
    cfg = load(cfg_path)
    # Not in dev mode: override ignored.
    assert cfg.backend_url == "https://api.alerts.example.com"


def test_agent_settings(env, config):
    cfg_path = env["config_dir"] / "config.toml"
    env["config_dir"].mkdir(parents=True)
    cfg_path.write_text(
        '[agents.nightly]\ntimeout = "3h"\nstall = "20m"\nnotify_done = false\n'
    )
    cfg = load(cfg_path)
    agent = cfg.agent("nightly")
    assert agent.timeout_seconds == 10800
    assert agent.stall_seconds == 1200
    assert agent.notify_done is False
    other = cfg.agent("missing")
    assert other.notify_done is True
    assert other.timeout == "2h"
    assert other.stall == "15m"


def test_config_roundtrip_save(env, config):
    config.set("general", "machine_id", "m_abc")
    config.save()
    reloaded = load(config.path)
    assert reloaded.machine_id == "m_abc"
    assert reloaded.backend_url == config.backend_url
    config.unset("general", "machine_id")
    config.save()
    assert load(config.path).machine_id == ""


def test_bad_privacy_mode(env):
    cfg_path = env["config_dir"] / "config.toml"
    env["config_dir"].mkdir(parents=True)
    cfg_path.write_text('[general]\nprivacy_mode = "nothing"\n')
    with pytest.raises(ConfigError):
        load(cfg_path)
