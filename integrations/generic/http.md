# Direct HTTP integration

For agents running inside your own code: post events to the API yourself.
**Prefer the CLI.** `agentwatch` already handles the outbox (events are
queued on disk and survive crashes and restarts), sender-side redaction of
summaries, retries and rate-limit backoff, heartbeats, and the machine-key
lifecycle. Direct HTTP means taking on all of that work.

Base URL: `https://<host>/api`.

## What you need

- A **machine key**: `aw_<machine_id>_<secret>`, issued once by the device
  enrollment flow (`agentwatch login` on the machine, or the equivalent
  `POST /api/device/start` + `POST /api/device/token` exchange). Store it
  like a password; it is shown exactly once.
- **Two headers on every request:**
  - `Authorization: Bearer aw_<machine_id>_<secret>`
  - `X-AgentWatch-Protocol: 1`

## Endpoints an agent needs

| Endpoint | Purpose | Success |
|---|---|---|
| `POST /api/events` | Report `question`, `done`, `failed`, `timed_out`, `stalled`. Body `{"events": [<event>, ...]}`, 1–50 events, ≤64 KB. | `202` |
| `POST /api/heartbeat` | Keep the machine from going silent. Roughly once a minute while running — anywhere well inside the 15-minute silence window. | `204` |
| `POST /api/signals` | Optional `output_seen`/`input_resumed` signals; `output_seen` for the run cancels question reminders. | `202` |

If nothing else heartbeats for the machine, send `POST /api/heartbeat`
yourself — after 15 minutes without one the backend creates a
`host_silent` event and alerts the user that the machine stopped reporting.

Event fields per `spec/schemas/event.schema.json`: `id` (UUID v4 — your
idempotency key), `agent`, `run_id`, `host`, `type`, `blocking` (`true` for
`question`/`failed`/`timed_out`, `false` for `done`/`stalled`), `summary`
(one line, ≤200 chars, **redacted before sending** using
`spec/redaction.json`), `exit_code`, `duration_s`, `email_allowed`,
`timestamp` (RFC 3339 UTC ending `Z`). Unknown fields are rejected. If the
agent runs inside `agentwatch run`, reuse `$AGENTWATCH_RUN_ID` so signals
and reminders attach to the run.

## Responses

`POST /api/events` returns `202` with one result per event, in order:

```json
{"results": [
  {"id": "uuid", "status": "accepted"},
  {"id": "uuid", "status": "duplicate"},
  {"id": "uuid", "status": "rejected", "reason": "summary exceeds 200 chars"}
]}
```

`accepted` = stored and routed. `duplicate` = same `id` seen before, or same
`(run_id, type, summary)` within 10 minutes — not an error. `rejected` =
that event failed validation; fix and resend only that event.

`POST /api/heartbeat` returns `204` (no body).

Errors use `{"error": {"code": "...", "message": "..."}}`; a missing
protocol header or machine key returns `401`/`426`.

## Retries

- The event `id` is the idempotency key: **retry the same body freely**;
  duplicates are absorbed server-side.
- `429 rate_limited`: wait `Retry-After` seconds (60 events/min/machine).
- `5xx` or connection failure: exponential backoff with jitter; keep the
  events in a durable local queue meanwhile.
- `4xx` other than `429`: do not retry — the request is malformed.
- `426 upgrade_required`: stop retrying; your protocol version is stale.
- On restart, resend everything still in your outbox.

## Examples

One `question` event, then a heartbeat. Substitute your host and key.

**curl**

```sh
BASE="https://<host>"
KEY="aw_<machine_id>_<secret>"

curl -sS -X POST "$BASE/api/events" \
  -H "Authorization: Bearer $KEY" \
  -H "X-AgentWatch-Protocol: 1" \
  -H "Content-Type: application/json" \
  -d '{"events": [{
        "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        "agent": "my-agent", "run_id": "run-01", "host": "workstation",
        "type": "question", "blocking": true,
        "summary": "Deploy to production? [y/N]",
        "exit_code": null, "duration_s": null,
        "email_allowed": true,
        "timestamp": "2026-01-01T10:00:00Z"
      }]}'

curl -sS -X POST "$BASE/api/heartbeat" \
  -H "Authorization: Bearer $KEY" \
  -H "X-AgentWatch-Protocol: 1" \
  -H "Content-Type: application/json" \
  -d '{"sent_at": "2026-01-01T10:00:30Z", "active_runs": 1}'
```

**Python (standard library)**

```python
import json
import urllib.request

BASE = "https://<host>"
KEY = "aw_<machine_id>_<secret>"


def post(path, payload):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {KEY}",
            "X-AgentWatch-Protocol": "1",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status, resp.read()


event = {
    "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "agent": "my-agent", "run_id": "run-01", "host": "workstation",
    "type": "question", "blocking": True,
    "summary": "Deploy to production? [y/N]",
    "exit_code": None, "duration_s": None,
    "email_allowed": True, "timestamp": "2026-01-01T10:00:00Z",
}
status, body = post("/api/events", {"events": [event]})   # 202, results list
status, _ = post("/api/heartbeat",
                 {"sent_at": "2026-01-01T10:00:30Z", "active_runs": 1})  # 204
```

**TypeScript (fetch)**

```ts
const BASE = "https://<host>";
const KEY = "aw_<machine_id>_<secret>";

async function post(path: string, payload: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "X-AgentWatch-Protocol": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

const event = {
  id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  agent: "my-agent", run_id: "run-01", host: "workstation",
  type: "question", blocking: true,
  summary: "Deploy to production? [y/N]",
  exit_code: null, duration_s: null,
  email_allowed: true, timestamp: "2026-01-01T10:00:00Z",
};

const eventsResp = await post("/api/events", { events: [event] }); // 202
const hbResp = await post("/api/heartbeat", {
  sent_at: "2026-01-01T10:00:30Z",
  active_runs: 1,
}); // 204
```
