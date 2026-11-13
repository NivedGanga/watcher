import pytest

from snitch import init


BLOCK = "<!-- snitch:start -->\nBLOCK BODY\n<!-- snitch:end -->"


def test_merge_into_empty():
    assert init.merge("", BLOCK) == BLOCK + "\n"


def test_merge_appends_to_existing():
    out = init.merge("# Rules\n", BLOCK)
    assert out.startswith("# Rules\n")
    assert "snitch:start" in out
    assert out.endswith("\n")


def test_merge_replaces_between_markers():
    old = "# Rules\n\n<!-- snitch:start -->\nOLD\n<!-- snitch:end -->\n\ntail\n"
    out = init.merge(old, BLOCK)
    assert "BLOCK BODY" in out and "OLD" not in out
    assert out.endswith("tail\n")


def test_merge_upgrades_agentwatch_block_in_place():
    old = "# Rules\n\n<!-- agentwatch:start -->\nOLD\n<!-- agentwatch:end -->\n\ntail\n"
    merged = init.merge(old, BLOCK)
    assert merged == "# Rules\n\n" + BLOCK + "\n\ntail\n"
    assert init.merge(merged, BLOCK) == merged


def test_cmd_init_creates_and_is_idempotent(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(init, "_block", lambda: BLOCK)
    assert init.cmd_init(["copilot"], False, lambda *a: None) == 0
    assert (tmp_path / "AGENTS.md").exists()
    assert (tmp_path / ".github/copilot-instructions.md").exists()
    assert init.cmd_init(["copilot"], False, lambda *a: None) == 0
    assert (tmp_path / "AGENTS.md").read_text().count("snitch:start") == 1


def test_cmd_init_global_writes_user_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(init, "_block", lambda: BLOCK)
    monkeypatch.setattr(init, "GLOBAL_FILES", [str(tmp_path / "home/.claude/CLAUDE.md")])
    assert init.cmd_init([], True, lambda *a: None) == 0
    assert "snitch:start" in (tmp_path / "home/.claude/CLAUDE.md").read_text()
