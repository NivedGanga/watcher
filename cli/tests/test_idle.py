"""Idle detection: ioreg/xprintidle parsing and input_resumed logic."""

from types import SimpleNamespace

import pytest

from agentwatch import idle
from agentwatch.daemon import IdleDetector
from conftest import outbox_signals


def _samples(values):
    it = iter(values)
    return lambda: next(it, None)


def test_idle_then_input_emits(store):
    det = IdleDetector(store, _samples([400.0, 2.0]), return_idle_s=300.0)
    det.sample()  # 400s idle
    det.sample()  # input: idle drops to 2s
    (sig,) = [s for s in outbox_signals({"data_dir": store.path.parent})
              if s["kind"] == "input_resumed"]
    assert sig["idle_seconds"] == 400.0
    assert sig["run_id"] is None
    assert sig["at"].endswith("Z")


def test_input_without_idle_emits_nothing(store):
    det = IdleDetector(store, _samples([10.0, 2.0]), return_idle_s=300.0)
    det.sample()
    det.sample()
    sigs = [s for s in outbox_signals({"data_dir": store.path.parent})
            if s["kind"] == "input_resumed"]
    assert sigs == []


def test_emits_once_per_episode(store):
    det = IdleDetector(
        store, _samples([400.0, 2.0, 1.0, 0.5]), return_idle_s=300.0
    )
    for _ in range(4):
        det.sample()
    sigs = [s for s in outbox_signals({"data_dir": store.path.parent})
            if s["kind"] == "input_resumed"]
    assert len(sigs) == 1


def test_peak_idle_then_partial_drop(store):
    # Idle reached the threshold earlier, drifted, then input arrived.
    det = IdleDetector(
        store, _samples([400.0, 100.0, 2.0]), return_idle_s=300.0
    )
    det.sample()
    det.sample()
    det.sample()
    sigs = [s for s in outbox_signals({"data_dir": store.path.parent})
            if s["kind"] == "input_resumed"]
    assert len(sigs) == 1
    # idle_seconds = the last idle value before input.
    assert sigs[0]["idle_seconds"] == 100.0


def test_none_sampler_emits_nothing(store):
    det = IdleDetector(store, lambda: None, return_idle_s=300.0)
    for _ in range(5):
        det.sample()
    assert outbox_signals({"data_dir": store.path.parent}) == []


def test_ioreg_parsing():
    def fake_run(*a, **kw):
        return SimpleNamespace(
            stdout='| "HIDIdleTime" = 5234567890\n', returncode=0
        )

    assert idle._ioreg_idle_seconds(fake_run) == pytest.approx(5.23456789)


def test_ioreg_missing_key():
    def fake_run(*a, **kw):
        return SimpleNamespace(stdout="nothing here", returncode=0)

    assert idle._ioreg_idle_seconds(fake_run) is None


def test_xprintidle_parsing():
    def fake_run(*a, **kw):
        return SimpleNamespace(stdout="2500\n", returncode=0)

    assert idle._xprintidle_seconds(fake_run) == 2.5


def test_detect_mode():
    assert idle.detect_mode("darwin") == "hid"
    assert idle.detect_mode("linux", which=lambda n: "/usr/bin/xprintidle") \
        == "xprintidle"
    assert idle.detect_mode("linux", which=lambda n: None) == "none"
