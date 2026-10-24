"""Tests for integrations/tools/sync_instructions.py.

Run with: python3 -m pytest integrations/tests/
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
TOOL = REPO_ROOT / "integrations" / "tools" / "sync_instructions.py"
SOURCE = REPO_ROOT / "integrations" / "generic" / "instructions.md"

START = "<!-- agentwatch:start -->"
END = "<!-- agentwatch:end -->"


def run_tool(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(TOOL), *args],
        capture_output=True,
        text=True,
    )


@pytest.fixture
def source_text() -> str:
    return SOURCE.read_text(encoding="utf-8")


@pytest.fixture
def target(tmp_path: Path) -> Path:
    f = tmp_path / "AGENT.md"
    f.write_text(
        f"# Agent file\n\n{START}\nold block contents\n{END}\n\nTrailing text.\n",
        encoding="utf-8",
    )
    return f


def test_replaces_only_marked_block(target: Path, source_text: str):
    result = run_tool("--target", str(target))
    assert result.returncode == 0, result.stderr
    text = target.read_text()
    assert text.startswith("# Agent file\n\n")
    assert text.endswith("\n\nTrailing text.\n")
    assert "## AgentWatch" in text
    assert "old block contents" not in text
    # The block is the source verbatim, markers included.
    assert source_text.rstrip("\n") in text


def test_idempotent(target: Path):
    assert run_tool("--target", str(target)).returncode == 0
    first = target.read_text()
    assert run_tool("--target", str(target)).returncode == 0
    second = run_tool("--target", str(target))
    assert second.returncode == 0
    assert "in sync" in second.stdout
    assert target.read_text() == first


def test_check_fails_on_drift(target: Path):
    assert run_tool("--target", str(target)).returncode == 0
    # Introduce drift inside the markers.
    text = target.read_text().replace("## AgentWatch", "## AgentWatch STALE")
    target.write_text(text)
    result = run_tool("--check", "--target", str(target))
    assert result.returncode == 1
    assert "out of date" in result.stdout
    assert target.read_text() == text  # --check writes nothing


def test_check_passes_when_in_sync(target: Path):
    assert run_tool("--target", str(target)).returncode == 0
    result = run_tool("--check", "--target", str(target))
    assert result.returncode == 0
    assert "in sync" in result.stdout


def test_refuses_file_without_markers(tmp_path: Path):
    f = tmp_path / "CLAUDE.md"
    f.write_text("# No markers here\n", encoding="utf-8")
    result = run_tool("--target", str(f))
    assert result.returncode == 2
    assert "no agentwatch markers" in result.stderr
    assert f.read_text() == "# No markers here\n"


def test_append_adds_block(tmp_path: Path, source_text: str):
    f = tmp_path / "NEW.md"
    f.write_text("# Heading\n", encoding="utf-8")
    result = run_tool("--append", "--target", str(f))
    assert result.returncode == 0, result.stderr
    text = f.read_text()
    assert text.startswith("# Heading\n")
    assert source_text.rstrip("\n") in text
    assert text.endswith(f"{END}\n")
    # A second run is a no-op.
    assert run_tool("--append", "--target", str(f)).returncode == 0
    assert f.read_text() == text


def test_leaves_text_outside_markers_unchanged(tmp_path: Path):
    before = "Intro.\n\n"
    after = "\nOutro: do not touch.\n"
    f = tmp_path / "MID.md"
    f.write_text(f"{before}{START}\nstale\n{END}{after}", encoding="utf-8")
    assert run_tool("--target", str(f)).returncode == 0
    text = f.read_text()
    assert text.startswith(before + START)
    assert text.endswith(END + after)


def test_missing_target_errors(tmp_path: Path):
    result = run_tool("--target", str(tmp_path / "nope.md"))
    assert result.returncode == 2
    assert "does not exist" in result.stderr


def test_unbalanced_markers_error(tmp_path: Path):
    f = tmp_path / "BAD.md"
    f.write_text(f"{START}\nno end marker\n", encoding="utf-8")
    result = run_tool("--target", str(f))
    assert result.returncode == 2


def test_multiple_targets(tmp_path: Path):
    a = tmp_path / "a.md"
    b = tmp_path / "b.md"
    for f in (a, b):
        f.write_text(f"{START}\nx\n{END}\n", encoding="utf-8")
    result = run_tool("--target", str(a), "--target", str(b))
    assert result.returncode == 0
    assert "## AgentWatch" in a.read_text()
    assert "## AgentWatch" in b.read_text()


def test_repo_agents_md_in_sync():
    """The checked-in AGENTS.md stays in sync with the source block."""
    result = run_tool("--check")
    assert result.returncode == 0, result.stdout + result.stderr
