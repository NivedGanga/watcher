# snitch

The Snitch CLI wraps agent processes on macOS, Linux, and Windows, queues their
lifecycle events locally, and delivers them to the Snitch server, which
routes alerts to your phone (web push) or email. All routing decisions happen
on the server; the CLI never sends the command line or agent output.

## Install

To install this checkout directly, run `pipx install ./cli` from the
repository root.

```
npm i -g snitch-tool    # prebuilt binaries, no Python needed (recommended)
```

or from source:

```
pipx install ./cli
```

### Windows Terminal

Use a PowerShell or Command Prompt profile. The npm release includes a Windows
x64 binary. If PowerShell blocks npm’s script shims, use `npm.cmd` and
`snitch.cmd`. With Python 3.11+ and pipx, `pipx install ./cli` installs from
this checkout.

```powershell
snitch login
snitch init
snitch daemon
```

Keep `snitch daemon` running in a separate tab to deliver alerts. In your
project tab, run `snitch ask` and `snitch done` as usual.

## Sign in

```
snitch login
```

This starts a device flow: a code is printed, your browser opens, and you
approve the machine. The machine key is written to
`~/.config/snitch/machine.key` (mode 0600) on macOS and Linux. Windows stores
config, the outbox, and the machine key under `%LOCALAPPDATA%\snitch` by
default, and encrypts the key for the signed-in Windows user.

```
snitch login --name my-laptop --no-browser   # print the URL instead
snitch login --yes                           # skip prompts
```

## Wrap a run

```
snitch run --name nightly-etl -- python3 etl.py
```

On macOS and Linux, the command runs in a pseudo-terminal. On Windows, run
scripts and executables with `snitch run --name nightly-etl -- python etl.py`.
The Windows wrapper inherits input and combines stdout and stderr into a pipe.
Programs may buffer their output when piped. Use `python -u` for immediate
Python output. Run batch files through `cmd.exe /c` and PowerShell scripts
through `powershell.exe -File` or `pwsh.exe -File`. Full-screen agents should
run directly in Windows Terminal and call `snitch ask` and `snitch done`.

The wrapper reports these events.

| Outcome | Event | Summary |
|---|---|---|
| exit 0 | `done` | `nightly-etl finished.` |
| exit N | `failed` | `nightly-etl exited with code N.` |
| killed by signal N | `failed` | `nightly-etl was killed by signal N.` |
| over `--timeout` | `timed_out` | `nightly-etl exceeded its timeout of 2h.` |
| no output for `--stall` | `stalled` | `nightly-etl has produced no output for 15m.` |

`snitch run` exits with the child's exit code. On macOS and Linux, it forwards
SIGINT and SIGTERM to the child's process group. On Windows, it requests
process tree termination on timeout or Ctrl+C. `stalled` never kills.

Defaults are `--timeout 2h` and `--stall 15m`; per-agent values can be set in
`config.toml` under `[agents.<name>]`.

## Ask and report from inside a run

Agents call these inside a wrapped run (they read `SNITCH_RUN_ID` and
`SNITCH_AGENT` from the environment):

```
snitch ask "Deploy to production? [y/N]"   # blocking question event
snitch done "Deployed 42 services"          # done event
```

Both write to the local outbox only and return immediately — no network.
Outside a run they use the machine name as the agent and a generated run id.

## The daemon

The daemon drains the outbox, sends heartbeats with the count of live runs,
and watches for user input returning after an idle period:

```
snitch daemon
```

On macOS and Linux, install it as a background service. The command prints
the steps to start it. On Windows, use `snitch daemon` in a separate tab.

```
snitch install-service      # launchd on macOS, systemd user unit on Linux
snitch uninstall-service
```

## Status and privacy

```
snitch status          # login, outbox counts, heartbeats, service state
snitch privacy         # show the current mode and what leaves the machine
snitch privacy metadata
```

- `full` (default): each event's one-line summary is sent after local secret
  redaction (API keys, tokens, passwords — see `spec/redaction.json`; add
  env var names to `general.redact_env` to redact their values too).
- `metadata`: summaries are replaced by fixed lines like
  `Question from {agent}`; question text, exit messages, commands, and output
  never leave the machine.

## Connectivity check

```
snitch test            # sends one event of each type, reports results
```

## Uninstall

```
snitch logout                  # revoke the machine and remove the key
snitch uninstall-service
pipx uninstall snitch
```

## Configuration

`~/.config/snitch/config.toml` on macOS and Linux or
`%LOCALAPPDATA%\snitch\config.toml` on Windows. See the
[example config](examples/config.toml).
Local state lives in `~/.local/share/snitch/outbox.sqlite` (WAL mode).

The daemon is not required for `run`, `ask`, `done`, `privacy`, or `status` —
they work offline and queue for later delivery. While logged out, events
queue for up to 7 days and are then dropped (shown in `status`).
# Mobile answers

Use `snitch ask --wait "Question?" --option "A" --option "B" --allow-text`.
Options have stable numeric string IDs (`"1"`, `"2"`, …). Without options, text
is allowed automatically. Prompts and text answers are limited to 4000
characters; up to eight option labels may each contain 200 characters. Prompts
and labels are redacted before local persistence or transmission.

`--timeout` defaults to `30m` and accepts an integer number of seconds up to
`24h`. The command writes one JSON result to stdout and diagnostics, question ID,
and recovery instructions to stderr. Result fields are `question_id`, `status`,
`answer`, and an optional `error` category. Answer is `{"option_id":"1","label":"A"}`
or `{"text":"reply"}`. Exit codes: answered 0, failed 1, CLI usage 2, expired 3,
cancelled 4. No failure constitutes a user decision.

`snitch wait <question_id>` resumes a locally persisted question on the same
enrolled machine, including creation retries after a lost response. SIGINT and
SIGTERM stop waiting with `wait_interrupted` and preserve the remote question;
another waiter may retrieve it later. These calls use outbound HTTPS directly,
so the delivery daemon is not required for question creation or answer polling.
Full privacy mode and login are required. Notification-only `ask` is unchanged.
