#!/usr/bin/env python3
"""Sync the AgentWatch instructions block into agent instruction files.

The block lives in ``integrations/generic/instructions.md`` between
``<!-- agentwatch:start -->`` and ``<!-- agentwatch:end -->`` markers. This
tool copies it into every target file that carries the same markers,
replacing only the marked region and leaving all other text untouched.

Usage:
    python3 sync_instructions.py                     # sync repo AGENTS.md
    python3 sync_instructions.py --target FILE ...   # sync other files
    python3 sync_instructions.py --check             # CI: fail on drift
    python3 sync_instructions.py --append --target F # add block when absent

Standard library only.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

START_MARKER = "<!-- agentwatch:start -->"
END_MARKER = "<!-- agentwatch:end -->"

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = REPO_ROOT / "integrations" / "generic" / "instructions.md"
DEFAULT_TARGET = REPO_ROOT / "AGENTS.md"

EXIT_OK = 0
EXIT_DRIFT = 1
EXIT_ERROR = 2


class SyncError(Exception):
    pass


def load_source(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise SyncError(f"cannot read source {path}: {exc}") from exc
    if START_MARKER not in text or END_MARKER not in text:
        raise SyncError(f"source {path} does not contain both markers")
    if text.index(END_MARKER) <= text.index(START_MARKER):
        raise SyncError(f"source {path}: end marker precedes start marker")
    return text.rstrip("\n") + "\n"


def render(original: str, source: str, append: bool, target: Path) -> str:
    """Return the new content for ``target``; raise SyncError if refused."""
    starts = original.count(START_MARKER)
    ends = original.count(END_MARKER)
    if starts == 0 and ends == 0:
        if not append:
            raise SyncError(
                f"{target}: no agentwatch markers; pass --append to add the block"
            )
        base = original
        if base and not base.endswith("\n"):
            base += "\n"
        if base:
            base += "\n"
        return base + source
    if starts != 1 or ends != 1:
        raise SyncError(
            f"{target}: expected exactly one start and one end marker "
            f"(found {starts} start, {ends} end)"
        )
    start = original.index(START_MARKER)
    end = original.index(END_MARKER) + len(END_MARKER)
    if end <= start:
        raise SyncError(f"{target}: end marker precedes start marker")
    # The replacement region ends at the end marker itself; the source's own
    # trailing newline belongs to the line after the marker, so strip it to
    # stay idempotent.
    return original[:start] + source.rstrip("\n") + original[end:]


def sync_target(target: Path, source: str, append: bool, check: bool) -> str:
    """Sync one file. Returns a status word for reporting."""
    if not target.exists():
        raise SyncError(f"{target}: file does not exist")
    if not target.is_file():
        raise SyncError(f"{target}: not a regular file")
    try:
        original = target.read_text(encoding="utf-8")
    except OSError as exc:
        raise SyncError(f"cannot read {target}: {exc}") from exc
    updated = render(original, source, append, target)
    if updated == original:
        return "in sync"
    if check:
        return "out of date"
    try:
        target.write_text(updated, encoding="utf-8")
    except OSError as exc:
        raise SyncError(f"cannot write {target}: {exc}") from exc
    return "updated"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Sync the marked AgentWatch instructions block into "
        "agent instruction files."
    )
    parser.add_argument(
        "--target",
        action="append",
        metavar="PATH",
        help="file to update (repeatable); default: AGENTS.md at the repo root",
    )
    parser.add_argument(
        "--source",
        metavar="PATH",
        default=str(DEFAULT_SOURCE),
        help=f"instructions block source (default: {DEFAULT_SOURCE})",
    )
    parser.add_argument(
        "--append",
        action="store_true",
        help="append the block to targets that have no markers "
        "(without it, such files are refused)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="write nothing; exit 1 if any target is out of date",
    )
    args = parser.parse_args(argv)

    try:
        source = load_source(Path(args.source))
    except SyncError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR

    targets = [Path(t) for t in args.target] if args.target else [DEFAULT_TARGET]

    errors = 0
    drift = 0
    for target in targets:
        try:
            status = sync_target(target, source, args.append, args.check)
        except SyncError as exc:
            print(f"error: {exc}", file=sys.stderr)
            errors += 1
            continue
        print(f"{status}: {target}")
        if status == "out of date":
            drift += 1

    if errors:
        return EXIT_ERROR
    if drift:
        return EXIT_DRIFT
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
