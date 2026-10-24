#!/usr/bin/env python3
"""Validate the AgentWatch spec artifacts.

Standard library only. Run from anywhere:

    python3 spec/validate.py

Checks:
  - every .json file under spec/ parses
  - every schema in spec/schemas/ has $schema, type, and required
  - every routing case has name, input, expected, and rule
  - every routing-case rule matches a level-2 heading in SPEC.md
  - every scenario in spec/fixtures/scenarios/ has steps and expected_events
"""

import json
import re
import sys
from pathlib import Path

SPEC_DIR = Path(__file__).resolve().parent

errors = []


def fail(msg):
    errors.append(msg)


def spec_headings():
    spec_md = SPEC_DIR / "SPEC.md"
    if not spec_md.is_file():
        fail("SPEC.md not found")
        return set()
    headings = set()
    for line in spec_md.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^## (.+?)\s*$", line)
        if m:
            headings.add(m.group(1))
    return headings


def check_json_parses():
    json_files = sorted(SPEC_DIR.rglob("*.json"))
    if not json_files:
        fail("no .json files found under spec/")
    parsed = {}
    for path in json_files:
        rel = path.relative_to(SPEC_DIR)
        try:
            parsed[path] = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            fail(f"{rel}: invalid JSON: {e}")
    return parsed


def check_schemas(parsed):
    schema_dir = SPEC_DIR / "schemas"
    expected = {
        "event.schema.json",
        "signal.schema.json",
        "heartbeat.schema.json",
        "fcm-data.schema.json",
    }
    found = {p.name for p in schema_dir.glob("*.schema.json")} if schema_dir.is_dir() else set()
    for name in sorted(expected - found):
        fail(f"schemas/{name}: missing")
    for path in sorted(schema_dir.glob("*.schema.json")) if schema_dir.is_dir() else []:
        rel = path.relative_to(SPEC_DIR)
        schema = parsed.get(path)
        if not isinstance(schema, dict):
            continue  # parse error already reported
        for key in ("$schema", "type", "required"):
            if key not in schema:
                fail(f"{rel}: missing '{key}'")


def check_routing_cases(parsed, headings):
    path = SPEC_DIR / "routing-cases.json"
    cases = parsed.get(path)
    if not isinstance(cases, list):
        if path.exists() and path not in parsed:
            return  # parse error already reported
        fail("routing-cases.json: expected a JSON array")
        return
    if not cases:
        fail("routing-cases.json: array is empty")
    for i, case in enumerate(cases):
        where = f"routing-cases.json[{i}]"
        if not isinstance(case, dict):
            fail(f"{where}: not an object")
            continue
        name = case.get("name", where)
        for key in ("name", "input", "expected", "rule"):
            if key not in case:
                fail(f"{name}: missing '{key}'")
        rule = case.get("rule")
        if isinstance(rule, str) and rule not in headings:
            fail(f"{name}: rule {rule!r} does not match a SPEC.md heading")


def check_scenarios(parsed):
    scen_dir = SPEC_DIR / "fixtures" / "scenarios"
    files = sorted(scen_dir.glob("*.json")) if scen_dir.is_dir() else []
    if not files:
        fail("fixtures/scenarios/: no scenario files found")
        return
    for path in files:
        rel = path.relative_to(SPEC_DIR)
        scenario = parsed.get(path)
        if not isinstance(scenario, dict):
            continue  # parse error already reported
        for key in ("steps", "expected_events"):
            if key not in scenario:
                fail(f"{rel}: missing '{key}'")


def main():
    parsed = check_json_parses()
    headings = spec_headings()
    if not headings:
        fail("SPEC.md has no level-2 headings")
    check_schemas(parsed)
    check_routing_cases(parsed, headings)
    check_scenarios(parsed)

    if errors:
        print(f"FAIL: {len(errors)} problem(s)")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("OK: all spec artifacts valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
