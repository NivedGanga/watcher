# AgentWatch

AgentWatch is a public, hosted alerting service for autonomous agents. Users
install the `agentwatch` CLI on their computers, sign in through a browser,
and receive alerts as web push notifications (phone or browser PWA) or by
email. All routing decisions happen on the server; the CLI queues events
locally and sends them. v1 is hosted only.

This repository is organized so that **every module is built from the files
in `spec/` alone**.

## Quick start (npm)

```sh
npm i -g agentwatch-tool      # installs the `agentwatch` command
agentwatch login              # prints a link — approve it in the PWA
agentwatch install-service    # persistent daemon (or: agentwatch daemon)
agentwatch init               # seeds AGENTS.md so agentic tools use it
agentwatch run --name demo -- python3 train.py
```

`agentwatch init` writes the instruction block into `AGENTS.md` (read by
Codex, Copilot, Cursor, Devin, Aider, Windsurf, …). Use `--agents
copilot,claude,gemini` to also write tool-specific files, and `--global` to
merge it into `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`
so it applies to every repo on the machine.

That's it: exits report `done`/`failed`, deadline overruns report
`timed_out`, silent runs report `stalled`, and `agentwatch ask`/`done` inside
any agent or script send blocking questions and completions to your phone.

macOS (arm64/x64) and Linux (x64/arm64) ship prebuilt binaries — no Python
required. Other ways to install: `pipx install ./cli`, or `npx agentwatch-tool`
for one-off runs.

## Layout

| Path | Contents | License |
|---|---|---|
| [`spec/`](spec/) | The protocol specification — the source of truth for all modules | Apache-2.0 |
| [`cli/`](cli/) | The `agentwatch` CLI (wraps agents, queues and sends events) | Apache-2.0 |
| [`integrations/`](integrations/) | Agent integrations and wrappers | Apache-2.0 |
| [`server/`](server/) | The hosted server: API, routing, push, email | AGPL-3.0 |

## The spec

- [`spec/SPEC.md`](spec/SPEC.md) — the rules, in plain language
- [`spec/api.md`](spec/api.md) — every endpoint, auth, request, response, errors
- [`spec/VERSIONING.md`](spec/VERSIONING.md) — protocol version policy
- [`spec/DECISIONS.md`](spec/DECISIONS.md) — which rules are user-specified vs. defaults
- [`spec/schemas/`](spec/schemas/) — JSON Schemas (2020-12) for events, signals, heartbeats, and FCM data payloads
- [`spec/redaction.json`](spec/redaction.json) — sender-side secret-redaction patterns
- [`spec/routing-cases.json`](spec/routing-cases.json) — normative routing test cases
- [`spec/fixtures/scenarios/`](spec/fixtures/scenarios/) — scripted fake agents for CLI conformance
- [`spec/conformance/README.md`](spec/conformance/README.md) — how third-party implementations run the cases
- [`spec/validate.py`](spec/validate.py) — structural validator (stdlib only)

Validate the spec artifacts:

```
python3 spec/validate.py
```

## Security

See [SECURITY.md](SECURITY.md).
