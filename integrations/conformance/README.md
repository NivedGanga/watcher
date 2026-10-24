# Integration conformance harness

Proves that the three integration paths — bare wrapper, instructions
block, direct HTTP — produce the same events for the same scenario.

## Run it

```sh
# With an installed agentwatch:
python3 integrations/conformance/harness.py

# Against a source checkout of the CLI:
PYTHONPATH=cli/src python3 integrations/conformance/harness.py \
    --agentwatch "python3 -m agentwatch"

# Faster / slower, one scenario:
python3 integrations/conformance/harness.py --scale 0.05 --scenario success
```

`--agentwatch` takes the command prefix to run (default: `agentwatch` on
PATH). `--scale` multiplies every scenario delay *and* the wrapper's
stall/timeout settings (default `0.1`: the 60 s stall becomes 6 s, the
300 s deadline 30 s), preserving the relative margins the scenarios rely
on. A fake clock cannot drive a real subprocess, so the harness scales
real time instead.

## What it does per scenario

For every `spec/fixtures/scenarios/*.json`:

- **Path A — wrapper.** Runs `agentwatch run --name conformance
  --timeout <scaled> --stall <scaled> -- python3 fake_agent.py
  --mode observe …`. The fake agent prints, sleeps, blocks on stdin at
  question steps, hangs, or waits for an externally delivered signal —
  nothing more. Events are read from the CLI's local outbox
  (`AGENTWATCH_DATA_DIR/outbox.sqlite`); nothing is sent anywhere.
- **Path B — instructions.** Same run, but `fake_agent.py --mode
  instrumented` calls `agentwatch ask` on question steps and
  `agentwatch done` where the scenario expects `done`.
- **Path C — direct HTTP.** A fake agent builds the expected events and
  POSTs them through the urllib example from `../generic/http.md` to an
  in-process `FakeBackend` — real urllib request/response handling, zero
  sockets (`http://backend.invalid` never resolves).

Each path must produce the scenario's `expected_events` — same types,
`blocking`, and `email_allowed`, in order.

## Statuses

| Status | Meaning |
|---|---|
| `PASS` | Produced events match `expected_events` exactly. |
| `FAIL` | Events differ — the detail line says how. This is a finding: either the CLI diverged from the spec contract or the path can't cover the scenario. |
| `N/A` | Paths B and C only apply to scenarios whose expected events include `question` or `done` — the types an agent can report itself. `failed`/`timed_out`/`stalled` are wrapper observations and are marked `N/A` for B and C. |
| `SKIP` | No `agentwatch` command was available for paths A/B. |

Exit code is `0` when nothing fails; `N/A` and `SKIP` do not fail the run.

## Environment contract for paths A/B

The harness runs the CLI with `AGENTWATCH_CONFIG_DIR` and
`AGENTWATCH_DATA_DIR` pointed at a temp directory, so it never touches a
real account, key, or outbox. `run` needs no login: events are read from
the local outbox, so no backend is needed either. (`FakeBackend.serve()`
can bind 127.0.0.1 for testing delivery against a real CLI, but the
harness does not use it.)

Answers to `question` steps are written to the wrapper's stdin, which the
wrapper forwards into the pty; external `signal` steps are sent to the
fake agent's pid (written to `--pid-file`).

## Files

- `harness.py` — runner, event comparison, report.
- `fake_agent.py` — replays scenario steps (`observe` / `instrumented`).
- `fake_backend.py` — in-process API fake: protocol-header check,
  machine-key auth, per-item `202` results, minimal event-schema
  validation, dedup.

See `../NOTES.md` for current findings.
