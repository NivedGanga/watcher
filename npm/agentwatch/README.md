# agentwatch-tool

Wrap any terminal agent or script — get a push notification or email on your
phone when it finishes, fails, stalls, hits a timeout, or needs a decision.

Works with any agentic tool — Claude Code, Codex, Copilot, Cursor, Devin,
Aider, custom scripts — anything that can run shell commands.

## Install

```sh
npm i -g agentwatch-tool        # or: npx agentwatch-tool <command>
```

Prebuilt binaries for macOS (arm64/x64) and Linux (x64/arm64) — no Python or
build step required.

## Setup (once)

```sh
agentwatch login                # prints a link — sign in + approve in the PWA
agentwatch install-service      # background daemon (or run `agentwatch daemon`)
agentwatch init                 # seeds AGENTS.md so agents discover the tool
```

The dashboard is hosted at https://agentwatch-web-ten.vercel.app — sign in
there on your phone, allow notifications, and flip **Phone alerts** on.

## Use it

```sh
agentwatch run --name build -- npm run build        # wraps any command
```

- exit 0 → `done`, non-zero → `failed`, deadline → `timed_out`, silence → `stalled`
- events queue locally when offline and flush on reconnect

Inside agents and scripts:

```sh
agentwatch ask "Deploy to prod or staging?"   # blocking question → your phone
agentwatch done "Migrated 42 models."          # completion → your phone
```

`agentwatch init` writes the instruction block into `AGENTS.md` (read by most
agentic tools). Add `--agents copilot,claude,gemini` for tool-specific files,
or `--global` to apply it to every repo on the machine
(`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`).

## Commands

| Command | Purpose |
|---|---|
| `agentwatch login` / `logout` | enroll / revoke this machine |
| `agentwatch run --name N -- cmd` | wrap a command, report lifecycle |
| `agentwatch ask` / `done` | signal from inside an agent or script |
| `agentwatch init` | seed instruction files for agentic tools |
| `agentwatch daemon` / `install-service` | delivery + heartbeat daemon |
| `agentwatch privacy [full\|metadata]` | what leaves the machine |
| `agentwatch status` | local state |
| `agentwatch test` | one event of each type |

## Privacy

Events carry only a one-line redacted summary — never the command line or
output. `metadata` mode replaces summaries with fixed labels
(`Question from {agent}`, `Task finished`) so nothing about the work leaves
the machine. Redaction happens locally before anything is queued.

## Links

- Repo + spec: https://github.com/NivedGanga/watcher
- Web PWA: https://agentwatch-web-ten.vercel.app
- Release notes: https://github.com/NivedGanga/watcher/releases
