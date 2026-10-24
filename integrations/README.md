# Agent integrations

How an agent reports to AgentWatch, least to most setup. The target here
is agents with no mobile app of their own.

| Level | Setup | Produces | Cannot cover |
|---|---|---|---|
| **1. Wrapper** — `agentwatch run -- <cmd>` | Install the CLI; wrap the launch command. Zero agent changes. | `done`, `failed`, `timed_out`, `stalled`; `output_seen` signals | `question` — a silent blocked prompt looks like a stall, not a question. Custom completion messages. Anything the agent does without writing output or detaching from the process group. |
| **2. Instructions** — block in the agent's instructions file | Level 1 + paste the [`generic/instructions.md`](generic/instructions.md) block into the file the agent reads (sync tool below). | Everything above, plus `question` via `agentwatch ask` and a custom `done` summary via `agentwatch done` | Relies on the agent actually reading its instructions and choosing to call the commands — behavioral, not enforced. |
| **3. Direct HTTP** — `POST /api/events` etc. | Agent code posts events with the machine key ([`generic/http.md`](generic/http.md)). | Any event type the agent chooses to send | Everything the CLI normally does for you: durable outbox, redaction, retries/backoff, heartbeats, dedup, `stalled`/`timed_out` supervision of the *agent itself* (an agent can't report its own silence or death). |

**The hard limit.** An agent with no shell or command channel, no
outbound HTTP, and no hook the host can wrap can't be integrated — and
AgentWatch can't reach it. If you can launch it, level 1 works. If you
can also edit its instructions, level 2 works. If it is your code, level
3 works. Otherwise it doesn't.

## Contents

- [`generic/instructions.md`](generic/instructions.md) — the one source of
  the instructions block (also generated into the repo root `AGENTS.md`).
- [`generic/wrapper.md`](generic/wrapper.md) — what `agentwatch run`
  sees, produces, and misses.
- [`generic/http.md`](generic/http.md) — endpoints, headers, examples,
  retry rules for direct HTTP.
- [`tools/sync_instructions.py`](tools/sync_instructions.py) — copies the
  block into instruction files; `--check` for CI.
- [`conformance/`](conformance/) — harness proving all paths emit the
  same events for each spec scenario.
- [`recipes/TEMPLATE.md`](recipes/TEMPLATE.md) — template for per-agent
  recipes.
- [`tests/`](tests/) — pytest tests for the sync tool.
- [`NOTES.md`](NOTES.md) — decisions, ambiguities, known gaps.

## Per-agent recipes

Recipes are added **one agent at a time**, after that agent's launch
command and instructions-file location are verified against its current
documentation — `recipes/TEMPLATE.md` records the source URL and the date
checked. No real recipes exist yet; ask for a specific agent and one gets
written and verified then.

## Deferred / out of scope

- **Claude Code plugin** — deferred; Claude has a mobile app and is not
  the target audience.
- **Native hook adapters** — added only after each host's hook docs are
  verified; nothing here invents hook behavior.
- **`agentwatch` binary availability** — the conformance harness skips
  wrapper paths cleanly when the CLI isn't installed.
