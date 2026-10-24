"""``agentwatch init`` — seed the agent-instruction block into the files
agentic tools read (AGENTS.md, CLAUDE.md, copilot-instructions, ...).

The block lives between ``<!-- agentwatch:start -->`` / ``<!-- agentwatch:end -->``
markers so repeated runs replace it instead of duplicating it.
"""

from __future__ import annotations

from importlib import resources
from pathlib import Path

START = "<!-- agentwatch:start -->"
END = "<!-- agentwatch:end -->"

# Repo-level instruction files for agents that don't read AGENTS.md.
AGENT_FILES = {
    "copilot": ".github/copilot-instructions.md",
    "claude": "CLAUDE.md",
    "gemini": "GEMINI.md",
}

# User-level files merged with --global: applied across every repo.
GLOBAL_FILES = [
    "~/.claude/CLAUDE.md",
    "~/.codex/AGENTS.md",
    "~/.gemini/GEMINI.md",
]


def _block() -> str:
    return (
        resources.files("agentwatch.data")
        .joinpath("instructions.md")
        .read_text(encoding="utf-8")
        .strip()
    )


def merge(existing: str, block: str) -> str:
    """Insert or replace the marked block inside *existing* file content."""
    start = existing.find(START)
    end = existing.find(END, start + len(START))
    if start != -1 and end != -1:
        return existing[:start] + block + existing[end + len(END) :]
    sep = "" if not existing else ("" if existing.endswith("\n\n") else "\n" if existing.endswith("\n") else "\n\n")
    return existing + sep + block + "\n"


def _apply(path: Path, block: str, out) -> str:
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    merged = merge(existing, block)
    if merged == existing:
        return "unchanged"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(merged, encoding="utf-8")
    return "updated" if existing else "created"


def cmd_init(agents: list[str], global_scope: bool, out=print) -> int:
    block = _block()
    targets = [Path("AGENTS.md")]
    targets += [Path(AGENT_FILES[a]) for a in agents if a != "agents-md"]
    if global_scope:
        targets += [Path(p).expanduser() for p in GLOBAL_FILES]
    status = 0
    for t in targets:
        try:
            result = _apply(t, block, out)
        except OSError as exc:
            out(f"{t}: failed ({exc})")
            status = 1
            continue
        out(f"{t}: {result}")
    return status
