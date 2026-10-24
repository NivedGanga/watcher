# NOTES — integrations module

Decisions, ambiguities, and known gaps. Ordered roughly by importance.

## Conformance findings (run against the in-flight CLI)

Measured with `cli/` at the state shown in this commit
(`PYTHONPATH=cli/src python3 integrations/conformance/harness.py
--agentwatch "python3 -m agentwatch"`):

| Result | Scenarios | Meaning |
|---|---|---|
| Path A pass | success, failure, timeout, killed_by_signal, stall_then_recover | Wrapper correctly produces `done`/`failed`/`timed_out`/`stalled`. |
| Path A fail | question_answered, question_unanswered | **The wrapper does not detect terminal questions.** A prompt printed to the pty followed by a blocked stdin read produces no `question` event — `question_answered` yields only `done`; `question_unanswered` yields `stalled` + `timed_out` (no open question → stall not suppressed). Options: CLI adds blocked-on-input detection, or the spec scenario semantics declare question steps to mean `agentwatch ask` (the CLI's own `cli/tests/fake_agent.py` already takes the second reading). Until then, questions require level 2+ — see the matrix. |
| Path B pass | question_unanswered | `agentwatch ask` enqueues the `question`, marks the run's question open (suppressing `stalled`), and the run deadline produces `timed_out`. The full mechanism works. |
| Path B fail | success, question_answered, stall_then_recover | **`agentwatch done` inside a wrapped run double-reports**: the manual `done` plus the wrapper's exit-0 `done` = two events where one is expected (verified directly — outbox holds both, e.g. "custom done" and "{agent} finished."). One task completion should alert once. Suggested CLI fix: `cmd_done` marks the run done-reported in the store and `runner` skips the exit `done` when the flag is set (or dedupe same-run `done` events). Recipes may alternatively tell agents not to call `done` right before exiting. |
| Path C pass | all applicable | Direct HTTP carries every expected event; the fake backend validates schema, headers, and per-item `202` results. |
| N/A | failure, timeout, killed_by_signal (paths B, C) | Scenarios with no `question`/`done` — nothing an agent can report itself. |
| N/A | — (path C semantics) | Path C posts `stalled`/`timed_out` where expected for transport parity, but a real direct-HTTP agent can't honestly self-report its own silence or death — those need a supervisor (the wrapper). |

## CLI state at build time

- `cli/` was built concurrently during this work; `cli/README.md` and
  `cli/NOTES.md` landed near the end. The docs here were written against
  `spec/` plus the observed code and then reconciled with `cli/README.md`
  (which confirms the wrapper reports "`done`, `failed`, `timed_out`, or
  `stalled` — and nothing else", and that `ask`/`done` enqueue and return
  immediately).
- All harness needs are met by the current CLI surface:
  `run --name N --timeout D --stall D -- CMD`, `ask`, `done`; env contract
  `AGENTWATCH_CONFIG_DIR`, `AGENTWATCH_DATA_DIR`, `AGENTWATCH_RUN_ID`,
  `AGENTWATCH_AGENT` (set by the wrapper), `AGENTWATCH_DEV` +
  `AGENTWATCH_BACKEND_URL` (loopback backend override).
- `agentwatch` is not on PATH here; the harness ran via
  `python3 -m agentwatch` with `PYTHONPATH=cli/src`. Without a runnable
  CLI, paths A/B report `SKIP`.
- `agentwatch ask`/`done` are fire-and-forget enqueues: `ask` does **not**
  collect the answer — the agent blocks on its own stdin as usual. The
  instructions block's wording ("call when you need a human decision")
  matches this.
- Observed detail: `done`'s `email_allowed` comes from the per-agent
  `notify_done` config (default true) — matches `expected_events`.
- `cli/NOTES.md` records that the spec's "heartbeat every 60 s" and
  "stall after 60 s" defaults were superseded by 5-minute / 15-minute
  CLI defaults — deliberate, not drift. The conformance scenarios pass
  their own `stall_after_s`/`run_timeout_s`, so the harness is unaffected.
- `AGENTWATCH_OUTPUT_SIGNAL_INTERVAL` exists as a test override for the
  30 s `output_seen` throttle; the harness doesn't need it (signals are
  not part of `expected_events`).

## Coverage limits (required reading)

- **An agent that never writes output and never asks produces only
  exit-based events** — `done`/`failed`/`timed_out` (plus `stalled` once
  per quiet period). Nothing else is observable.
- **The stall timer depends on output visible through the pty.** Bytes
  written to the terminal reset it; work that never reaches the pty —
  files, network calls, silent compute — does not.
- Processes that detach from the run's process group escape: their
  output isn't seen and the deadline kill doesn't reach them.
- `question` exists only when the agent reports it (`ask` or HTTP). A
  terminal prompt is not a question to the wrapper — see the findings.

## Harness design decisions

- **No fake clock possible** against a real subprocess, so the harness
  scales real time (`--scale`, default 0.1): scenario delays and the
  wrapper's `--timeout`/`--stall` all scale together, preserving the
  margins (e.g. sleep 70 s vs stall 60 s → 7 s vs 6 s).
- **Events are read from the CLI's local outbox**
  (`outbox.sqlite`, `kind='event'`, ordered) — exactly "the events the
  CLI emits" per the spec conformance README; locally queued `started`
  records live in the `runs` table and are excluded naturally. `run`
  needs no login, so no backend is stood up for paths A/B.
- **Path C makes zero network calls**: a custom `urllib` handler routes
  `http://backend.invalid` requests to the in-process `FakeBackend`, so
  the real request machinery (headers, body, status handling) is
  exercised without sockets. `FakeBackend.serve()` exists for a future
  real-CLI delivery test over 127.0.0.1 but is unused by the harness.
- **`AGENTWATCH_CMD`** tells the instrumented fake agent how to invoke
  `agentwatch` for nested `ask`/`done` calls (set by the harness;
  `python -m agentwatch` prefixes are pinned to `sys.executable`).
- Question answering is fed through the wrapper's stdin per
  `answer_delay_s`; external `signal` steps are sent to the fake agent's
  pid file. This mirrors "input arrives" / "the process receives signal"
  rather than self-inflicted behavior.

## Sync tool

- Markers: `<!-- agentwatch:start -->` / `<!-- agentwatch:end -->`.
  Only the region between (and including) the markers is replaced; all
  other bytes are preserved. Idempotent; `--check` exits 1 on drift;
  files without markers are refused unless `--append` (which adds the
  block at EOF). Missing files are always an error — the tool never
  creates files outside explicit `--target` paths.
- Root `AGENTS.md` was bootstrapped (header + empty markers) and filled
  by the tool; regenerating is a no-op.

## Out of scope / deferred

- Per-agent recipes (template only; one agent at a time, docs-verified).
- Claude Code plugin — deferred; Claude has a mobile app.
- Native hook adapters — only after hook docs are verified per host.
- Server, CLI, web, and spec code — findings above are recorded for
  their owners.
