# AgentWatch conformance

This directory describes how a third-party implementation (a server, a
routing engine, or a CLI) checks itself against the normative fixtures in
this repository:

- `../routing-cases.json` — routing decision cases for the **server**.
- `../fixtures/scenarios/*.json` — scripted fake agents for the **CLI**.
- `../SPEC.md` — the plain-language rules. Where a fixture and SPEC.md
  disagree, SPEC.md wins; please report the disagreement.

## Running routing-cases.json

`routing-cases.json` is an array of `{name, input, expected, rule}` objects.
`rule` names the SPEC.md section under test.

### Input vocabulary

| field | meaning |
|---|---|
| `now` | the evaluation instant (RFC 3339 UTC) |
| `account.notify_on_phone` | the away flag |
| `account.phone_alerts_since` | when the flag was last turned on (or `null`) |
| `account.email_verified` | whether the account email is verified |
| `devices[]` | push devices: `{id, revoked_at, last_seen_at}` (either timestamp may be `null`) |
| `events[]` | events to route, in order: `{type, run_id, agent, summary, timestamp, blocking, email_allowed, receipt_within_120s, host?}` |
| `events[].receipt_within_120s` | whether **any** of the event's push deliveries receives a receipt within 2 minutes of the push |
| `signals[]` | signals visible to the router: `{kind, run_id, at, idle_seconds?}` |
| `machine` | for `silence_check` triggers: `{id, last_heartbeat_at, last_active_runs, already_silent}` |
| `trigger` | what to evaluate (see below) |

### Triggers

- `{"kind": "events"}` — feed `events` to the router in order, at their
  `timestamp`s. If `advance_to` is present, run scheduled work (window
  close-out, reminders, fallbacks) up to that instant afterwards.
- `{"kind": "signal"}` — deliver `signals` to the flag/auto-off logic.
- `{"kind": "tick"}` — run one scheduler tick at `now` (silence detection,
  fallbacks, reminders, grouping close-out, hard cap).
- `{"kind": "silence_check"}` — evaluate the 15-minute silence rule for
  `machine` at `now`.
- `{"kind": "http", "method", "path", "body"}` — perform the request as the
  described account and compare the outcome to `expected.error`.

### Expected vocabulary

| field | meaning |
|---|---|
| `pushes[]` | ordered push messages: `{event_type, urgency, deliveries, summary_pattern?}`. `deliveries` = number of active devices pushed. `summary_pattern` asserts the push summary contains that text. |
| `state_pushes[]` | ordered `state` messages: `{on, deliveries}` (`on` is `"true"`/`"false"`). |
| `emails[]` | ordered emails: `{kind, delay_s, sent}`. `kind` is `immediate` (row: flag off, no app), `fallback` (2-minute fallback), `reminder` (question + 10 min), or `host_silent`. `delay_s` is relative to the event's push/question timestamp. `sent: false` means scheduled but cancelled/suppressed. |
| `stored` | count of events stored. |
| `duplicates` | count of events marked `duplicate`. |
| `notify_on_phone` | flag value after evaluation. |
| `device_active` | whether the device set contains ≥1 active device. |
| `machine_silent` | whether the machine is marked silent. |
| `host_silent` | `{created, alerted}` for silence checks. |
| `error` | `{status, code}` for `http` triggers. |

Empty lists mean "none produced". Implementations should treat every key in
`expected` as normative and may ignore keys they do not model only when
documenting why.

### Procedure

1. For each case, build fresh state from `input` (one account, its devices,
   machines; no cross-case leakage).
2. Execute `trigger` with a fake clock fixed at `now`.
3. Record pushes, state pushes, emails, storage, and flag changes in order.
4. Compare against `expected` field-by-field. A case passes only if every
   listed expectation matches, including empty lists.

## Running fixtures/scenarios/*.json

Each scenario is `{name, description, params, steps, expected_events}` and
drives a **fake agent** under the CLI's wrapper.

### Params

- `stall_after_s` — seconds without output that produce a `stalled` event.
- `run_timeout_s` — run deadline that produces `timed_out`.

### Step vocabulary

| step | meaning |
|---|---|
| `{"output": "<line>", "delay_s": N}` | the agent prints `<line>` N seconds after the previous step completed |
| `{"sleep_s": N}` | the agent is silent for N seconds |
| `{"question": "<prompt>", "answered": bool, "answer_delay_s"?: N}` | the agent prints `<prompt>` and blocks for input. If `answered`, input arrives N seconds later (default 30). If not, it waits forever. |
| `{"hang": true}` | the agent never exits and produces no more output |
| `{"exit": code}` | the agent exits with `code` |
| `{"signal": "<name>", "after_s": N}` | the process receives signal `<name>` N seconds after the previous step and dies |

### Procedure

1. Launch the fake agent under the CLI wrapper with the scenario's `params`.
2. Replay `steps` with a fake clock.
3. Collect the events the CLI emits (locally queued `started` records are not
   events and are excluded).
4. Compare to `expected_events`: same length, same order, and matching
   `type`, `blocking`, and `email_allowed` on each entry.

A conforming implementation reproduces every scenario exactly.
