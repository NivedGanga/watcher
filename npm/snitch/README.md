# snitch-tool

Wrap any terminal agent or script — get a push notification or email on your
phone when it finishes, fails, stalls, hits a timeout, or needs a decision.

Works with any agentic tool — Claude Code, Codex, Copilot, Cursor, Devin,
Aider, custom scripts — anything that can run shell commands.

## Install

For a local source install, run `pipx install ./cli` from the repository root.

```sh
npm i -g snitch-tool        # or: npx snitch-tool <command>
```

Prebuilt binaries for macOS (arm64/x64), Linux (x64/arm64), and native Windows
(x64) require no Python or build step.

## Setup (once)

```sh
snitch login                # prints a link — sign in + approve in the PWA
snitch install-service      # background daemon (or run `snitch daemon`)
snitch init                 # seeds AGENTS.md so agents discover the tool
```

In PowerShell or Command Prompt, run `snitch daemon` in a separate tab
instead of `snitch install-service`.

The dashboard is hosted at https://agentwatch-web-ten.vercel.app — sign in
there on your phone, allow notifications, and flip **Phone alerts** on.

## Use it

```sh
snitch run --name build -- npm run build        # wraps any command
```

- exit 0 → `done`, non-zero → `failed`, deadline → `timed_out`, silence → `stalled`
- events queue locally when offline and flush on reconnect

Inside agents and scripts:

```sh
snitch ask --wait "Deploy to prod or staging?"   # wait for a reply from your phone
snitch done "Migrated 42 models."          # completion → your phone
```

`snitch init` writes the instruction block into `AGENTS.md` (read by most
agentic tools). Add `--agents copilot,claude,gemini` for tool-specific files,
or `--global` to apply it to every repo on the machine
(`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`).

Upgrading from AgentWatch: run `npm uninstall -g agentwatch-tool` before
installing `snitch-tool` to avoid a command conflict. This preserves local
configuration and queued events. `agentwatch` remains a command alias. Snitch reuses
existing configuration, machine keys, queued events, and service files, and
accepts legacy `AGENTWATCH_` settings. Run `snitch init` to update existing
agent instruction blocks and `snitch install-service` to update the daemon.

## Commands

| Command | Purpose |
|---|---|
| `snitch login` / `logout` | enroll / revoke this machine |
| `snitch run --name N -- cmd` | wrap a command, report lifecycle |
| `snitch ask` / `done` | signal from inside an agent or script |
| `snitch init` | seed instruction files for agentic tools |
| `snitch daemon` / `install-service` | delivery + heartbeat daemon |
| `snitch privacy [full\|metadata]` | what leaves the machine |
| `snitch status` | local state |
| `snitch test` | one event of each type |

## Privacy

Events carry only a one-line redacted summary — never the command line or
output. `metadata` mode replaces summaries with fixed labels
(`Question from {agent}`, `Task finished`) so nothing about the work leaves
the machine. Redaction happens locally before anything is queued.

## Links

- Repo + spec: https://github.com/NivedGanga/watcher
- Web PWA: https://agentwatch-web-ten.vercel.app
- Release notes: https://github.com/NivedGanga/watcher/releases
