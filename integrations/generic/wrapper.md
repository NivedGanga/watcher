# Wrapping a command: `agentwatch run`

The lowest-effort integration. No changes to the agent.

```sh
agentwatch run --name <agent-name> -- <command> [args...]
```

The CLI starts `<command>` under a pseudo-terminal (pty), watches its
output and its process, and reports events to the AgentWatch server. It
works with anything that runs in a shell: an agent binary, a shell script,
`python3 agent.py`, a `make` target. `agentwatch run` exits with the
child's exit code, so wrapped commands still compose in scripts.

Environment variables the wrapper sets for the child:

| Variable | Value |
|---|---|
| `AGENTWATCH_RUN_ID` | A UUID identifying this run; matches `run_id` on every event the run produces. Nested `agentwatch` calls (see the instructions block) use it to attach events to the run. |
| `AGENTWATCH_AGENT` | The agent name the run is registered under; matches `agent` on every event. |

The child also inherits the caller's full environment, so `agentwatch ask`
and `agentwatch done` invoked anywhere inside the run attribute themselves
correctly.

## What each exit path produces

| How the run ends | Event | `blocking` |
|---|---|---|
| Child exits `0` | `done` — "finished" | no |
| Child exits non-zero | `failed` — carries `exit_code` | yes |
| Child killed by a signal (`kill`, OOM, `^C`) | `failed` — carries the signal | yes |
| Run deadline exceeded | `timed_out` — wrapper kills the child's process group (TERM, then KILL after a grace period) | yes |
| No output for the stall threshold | `stalled` | no |

The run deadline and the stall threshold default to `--timeout 2h` and
`--stall 15m`, with per-agent values under `[agents.<name>]` in
`config.toml`. `stalled` is suppressed while a `question` is outstanding
for the same run (the agent is waiting on a human, not stuck — see
`spec/SPEC.md`, "Modifiers"); it stays open until the agent next prints.
A `stalled` event fires once per quiet period; output resets the clock.
`stalled` never kills — only the run deadline does.

Exit-path events carry `run_id`, `host`, `duration_s`, `exit_code` (where
meaningful), and a redacted one-line `summary`.

## What counts as output

Anything the child writes to the pty — stdout and stderr are merged onto one
stream. A single byte resets the stall clock: log lines, progress bars,
terminal control sequences from a TUI. Periodic `output_seen` signals are
also reported; the server uses them to cancel question reminders once the
agent is clearly working again.

Data that never reaches the pty does not count: files written to disk,
network traffic, silent computation.

## Interactive programs under the pty

The child sees a real terminal (`isatty()` is true), so agents behave as
they do in a live shell — color output, interactive prompts, readline
editing. The wrapper mirrors child output to your terminal and forwards
your keystrokes to the child. `SIGINT`/`SIGTERM` sent to the wrapper are
forwarded to the child's process group, so `Ctrl-C` reaches the agent.
Window resizes are forwarded as `SIGWINCH`.

When the agent prints a prompt and blocks on input — "Deploy to
production? [y/N]" — the run is waiting on you, but the wrapper does not
turn a silent wait into an alert on its own: from the outside it is
indistinguishable from silent work, so it reads as `stalled`, not
`question`. An `agentwatch ask` call (see `instructions.md`) is what
reports the question — and while a question is outstanding for the run,
`stalled` stays suppressed.

## What the wrapper cannot see

- **Work that produces no output.** A silent agent looks idle: you get
  `stalled`, then nothing until it exits or hits the deadline. The stall
  clock measures output through the pty only.
- **Processes that detach.** A child that double-forks or `setsid`s out of
  the run's process group escapes: its output never crosses the pty, and
  the deadline kill does not reach it. The wrapper reports the parent's
  exit, not the orphan's fate.
- **Meaning.** The wrapper sees bytes and exit codes, not intent. "Task
  complete" and "task failed" printed to a log look identical until the
  process exits. Semantic events — real questions, real completions — come
  from the instructions block or `agentwatch ask`/`done`.

## See also

- `instructions.md` — teach the agent to report questions and completions
  itself.
- `http.md` — post events without the CLI (and everything you then own).
- `../conformance/` — proves all three paths produce the same events.
