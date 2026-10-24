"""Sender-side redaction per spec/redaction.json.

Applied to every free-text field before an outbox insert: summaries,
question text, agent names, and host names. Values of environment variables
listed in ``general.redact_env`` are also redacted wherever they appear.
"""

from __future__ import annotations

import json
import os
import re
from importlib import resources

_FLAG_MAP = {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL}


def load_patterns() -> list[dict]:
    with resources.files("agentwatch.data").joinpath("redaction.json").open(
        "r", encoding="utf-8"
    ) as fh:
        return json.load(fh)


class Redactor:
    def __init__(self, env_values: list[str] | None = None):
        self._rules: list[tuple[re.Pattern, str]] = []
        for rule in load_patterns():
            flags = 0
            for ch in rule.get("flags", ""):
                flags |= _FLAG_MAP[ch]
            self._rules.append(
                (re.compile(rule["pattern"], flags), rule["replacement"])
            )
        # Redact env values literally; longest first so a longer value is not
        # partially masked by a shorter one. Empty values are skipped.
        self._env_values = sorted(
            {v for v in (env_values or []) if v}, key=len, reverse=True
        )

    @classmethod
    def from_config(cls, config) -> "Redactor":
        values = [
            os.environ[name]
            for name in config.redact_env
            if os.environ.get(name)
        ]
        return cls(values)

    def redact(self, text: str | None) -> str:
        if not text:
            return ""
        for value in self._env_values:
            text = text.replace(value, "[REDACTED]")
        for pattern, replacement in self._rules:
            text = pattern.sub(replacement, text)
        return text
