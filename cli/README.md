# agentwatch

The AgentWatch CLI wraps agent processes on macOS and Linux, queues their
lifecycle events locally, and delivers them to the AgentWatch server, which
routes alerts to your phone (web push) or email. All routing decisions happen
on the server; the CLI never sends the command line or agent output.

Native Windows is not supported; WSL works.

## Install

```
npm i -g agentwatch-tool    # prebuilt binaries, no Python needed (recommended)
```

or from source:

```
pipx install agentwatch
```

## Sign in

```
agentwatch login
```

This starts a device flow: a code is printed, your browser opens, and you
approve the machine. The machine key is written to
`~/.config/agentwatch/machine.key` (mode 0600) and never shown again.

```
agentwatch login --name my-laptop --no-browser   # print the URL instead
agentwatch login --yes                           # skip prompts
```

## Wrap a run

```
agentwatch run --name nightly-etl -- python3 etl.py
```

The command runs in a pseudo-terminal; input and output pass through
unchanged. The wrapper reports `done`, `failed`, `timed_out`, or `stalled`
events — and nothing else:

| Outcome | Event | Summary |
|---|---|---|
| exit 0 | `done` | `nightly-etl finished.` |
| exit N | `failed` | `nightly-etl exited with code N.` |
| killed by signal N | `failed` | `nightly-etl was killed by signal N.` |
| over `--timeout` | `timed_out` | `nightly-etl exceeded its timeout of 2h.` |
| no output for `--stall` | `stalled` | `nightly-etl has produced no output for 15m.` |

`agentwatch run` exits with the child's exit code. SIGINT and SIGTERM are
forwarded to the child's process group. `stalled` never kills.

Defaults are `--timeout 2h` and `--stall 15m`; per-agent values can be set in
`config.toml` under `[agents.<name>]`.

## Ask and report from inside a run

Agents call these inside a wrapped run (they read `AGENTWATCH_RUN_ID` and
`AGENTWATCH_AGENT` from the environment):

```
agentwatch ask "Deploy to production? [y/N]"   # blocking question event
agentwatch done "Deployed 42 services"          # done event
```

Both write to the local outbox only and return immediately — no network.
Outside a run they use agent `adhoc` and a generated run id.

## The daemon

The daemon drains the outbox, sends heartbeats with the count of live runs,
and watches for user input returning after an idle period:

```
agentwatch daemon
```

Install it as a background service (prints the start command; does not start
it):

```
agentwatch install-service      # launchd on macOS, systemd user unit on Linux
agentwatch uninstall-service
```

## Status and privacy

```
agentwatch status          # login, outbox counts, heartbeats, service state
agentwatch privacy         # show the current mode and what leaves the machine
agentwatch privacy metadata
```

- `full` (default): each event's one-line summary is sent after local secret
  redaction (API keys, tokens, passwords — see `spec/redaction.json`; add
  env var names to `general.redact_env` to redact their values too).
- `metadata`: summaries are replaced by fixed lines like
  `Question from {agent}`; question text, exit messages, commands, and output
  never leave the machine.

## Connectivity check

```
agentwatch test            # sends one event of each type, reports results
```

## Uninstall

```
agentwatch logout                  # revoke the machine and remove the key
agentwatch uninstall-service
pipx uninstall agentwatch
```

## Configuration

`~/.config/agentwatch/config.toml` — see [examples/config.toml](examples/config.toml).
Local state lives in `~/.local/share/agentwatch/outbox.sqlite` (WAL mode).

The daemon is not required for `run`, `ask`, `done`, `privacy`, or `status` —
they work offline and queue for later delivery. While logged out, events
queue for up to 7 days and are then dropped (shown in `status`).
