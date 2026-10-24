# AgentWatch Protocol Specification

Protocol version: 1 (see [Versioning](#versioning) and [VERSIONING.md](VERSIONING.md)).

AgentWatch is a public, hosted service. Users install the `agentwatch` CLI on
their computers, sign in through a browser, and receive alerts as web push
notifications (on a phone or browser PWA) or by email. The CLI wraps an agent
process, queues events locally, and sends them to the server. **All routing
decisions happen on the server.** v1 is hosted only; self-hosting is not part
of this protocol.

Every rule below is marked **user-specified** where it was given directly, or
**default (confirm)** where this specification chose the conservative option.
See [DECISIONS.md](DECISIONS.md) for the rationale for each rule.

Normative machine-readable artifacts: [schemas/](schemas/),
[redaction.json](redaction.json), [routing-cases.json](routing-cases.json),
[fixtures/scenarios/](fixtures/scenarios/).

## Authentication

There are three credential types. (user-specified)

- **Web app.** Users sign in with Google through Firebase. Every web-app
  request carries a Firebase ID token in the `Authorization` header:
  `Authorization: Bearer <firebase_id_token>`. (default, confirm)
- The account's email **must be verified** for every account action.
  Unverified requests to account endpoints fail with `403` and code
  `email_not_verified`. (user-specified)
- **Machines.** The CLI authenticates with
  `Authorization: Bearer aw_<machine_id>_<secret>`. The secret is shown to the
  user exactly once at enrollment and is stored hashed on the server.
  (user-specified)
- **Web push devices.** A registered browser authenticates with
  `Authorization: Device <device_id>.<device_secret>`. This credential may be
  used **only** for `POST /api/receipts` and `POST /api/devices/seen`; it is
  not an account credential. (user-specified)
- Credentials are compared in constant time and are never logged.
  (default, confirm)

## Event model

An event is the unit of work the CLI reports and the server stores and routes.
(user-specified)

- `id` — client-generated UUID v4. It is the idempotency key: a second event
  with the same `id` is a duplicate. (user-specified)
- Fields: `id`, `agent` (string, 1–64 chars), `run_id` (string, 1–64 chars),
  `host` (string, 1–128 chars), `type`, `blocking` (boolean), `summary`
  (one line, max 200 chars, redacted by the sender before sending),
  `exit_code` (integer or null), `duration_s` (number or null),
  `email_allowed` (boolean), `timestamp` (RFC 3339, UTC, ending in `Z`).
  (user-specified)
- Unknown fields are rejected. (user-specified)
- CLI-sent types: `question`, `done`, `failed`, `timed_out`, `stalled`.
  `blocking` is `true` for `question`, `failed`, and `timed_out`; `false` for
  `done` and `stalled`. (user-specified)
- `host_silent` is created by the backend, never sent by a client.
  (user-specified)
- `started` is never sent; it is recorded locally by the CLI only.
  (user-specified)
- Wire schema: [schemas/event.schema.json](schemas/event.schema.json).
- `summary` must be redacted by the sender using
  [redaction.json](redaction.json) before transmission. The server treats
  `summary` as opaque text and does not re-redact. (default, confirm)

## Signals

Signals are side-channel observations the CLI reports; they are not alerts and
are never routed to the user. (user-specified)

- Fields: `id`, `kind` (`output_seen` or `input_resumed`), `run_id`
  (required for `output_seen`, null otherwise), `at` (RFC 3339 UTC ending in
  `Z`), `idle_seconds` (`input_resumed` only; seconds of user idle time
  before input resumed). (user-specified)
- `output_seen` means the wrapped agent produced output. `input_resumed`
  means the user provided input to the machine after being idle.
  (user-specified)
- Wire schema: [schemas/signal.schema.json](schemas/signal.schema.json).
- `output_seen` signals drive question-reminder cancellation (see
  [Modifiers](#modifiers)). `input_resumed` signals drive auto-off (see
  [Away flag and auto-off](#away-flag-and-auto-off)). (user-specified)

## Heartbeat

- Fields: `sent_at` (RFC 3339 UTC ending in `Z`), `active_runs`
  (integer ≥ 0). (user-specified)
- Wire schema: [schemas/heartbeat.schema.json](schemas/heartbeat.schema.json).
- The CLI sends a heartbeat every 60 seconds while it is running, and once on
  shutdown if possible. (default, confirm)

## Devices and presence

- A push device is a browser registration holding an FCM token, created by the
  web app via `POST /api/devices`. Device fields: `revoked_at`,
  `last_seen_at`. (user-specified)
- A device is **active** iff `revoked_at` is null AND `last_seen_at` is
  strictly within the last 14 days (age < 14 days; a device seen exactly
  14 days ago is stale and inactive). (boundary: default, confirm)
- An FCM `not-registered` response for a device's token sets `revoked_at`.
  (user-specified)
- `last_seen_at` updates on receipt posts and on the seen ping.
  (user-specified)
- "App signed in" / "active app" in the Routing table means the account has at
  least one active device. A signed-in browser without notification permission
  does not count. (default, confirm)

## Machine enrollment

Enrollment uses the RFC 8628 device authorization flow. (user-specified)

- `POST /api/device/start` with `client_name` and `client_os` returns
  `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`,
  `expires_in` (600 seconds), and `interval` (5 seconds). (user-specified)
- `user_code` is 8 characters drawn from the alphabet
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no `0`, `O`, `1`, `I`), displayed to the
  user as `XXXX-XXXX`. Matching is case-insensitive and accepts input with or
  without the dash. `device_code` and `user_code` are stored hashed.
  (user-specified)
- The CLI polls `POST /api/device/token` with `device_code`. RFC 8628 error
  responses: `authorization_pending` (keep polling), `slow_down` (increase the
  poll interval by 5 seconds), `expired_token` (start over), `access_denied`
  (the user denied the request). (user-specified)
- On success the endpoint returns `{machine_id, key}` **exactly once**. The
  `key` is created at this poll, not at approval. A poll with a
  already-redeemed `device_code` returns `access_denied`. (redemption rule:
  default, confirm)
- The web app calls `GET /api/device/pending?user_code=` to look up a pending
  request, then `POST /api/device/approve` or `POST /api/device/deny`.
  (user-specified)
- On approval the server sends a "New computer connected" email to the
  verified address containing the computer name, OS, and a link to the
  computers page. (user-specified)
- Approving a machine that would exceed the machine limit fails with `409`
  `limit_reached`. (default, confirm)

## Machines

- A machine that has sent no heartbeat for 15 minutes is **silent**.
  (user-specified)
- When a machine becomes silent, the backend creates a `host_silent` event —
  at most once per silence episode. A silence episode ends when the machine
  sends a heartbeat again. (user-specified)
- A silent machine whose last heartbeat reported `active_runs = 0` is marked
  silent but produces **no** alert — the machine went quiet with nothing
  running, which is expected. (default, confirm)
- A `host_silent` event carries `run_id` of the machine's most recent run, or
  `none` when there is none, and a summary of the form
  `{host} has stopped reporting.` (default, confirm)

## Routing

The table applies to `question`, `failed`, `timed_out`, and `done`.
`stalled` and `host_silent` are handled by [Modifiers](#modifiers) only.
(user-specified)

| `notify_on_phone` | Active app | Result |
|---|---|---|
| true | yes | Push to every active device. If no receipt exists for any of its push deliveries within 2 minutes, send email. |
| true | no | Nothing |
| false | yes | Nothing |
| false | no | Email immediately |

- Each push delivery carries a `delivery_id`. A receipt for **any** of the
  event's push deliveries suppresses the fallback email. (user-specified)
- The 2-minute fallback window starts when the pushes are sent.
  (default, confirm)

## Modifiers

Type-specific adjustments to the Routing table. (default, confirm unless noted)

- `done`: routed by the table. The fallback/immediate email is sent **only if
  `email_allowed` is true**. Push urgency normal. (user-specified)
- `failed` and `timed_out`: push urgency high. `email_allowed` does **not**
  apply — these events always email when the table says email. Known
  trade-off: under the table they produce nothing when the flag is on and no
  app is present, and nothing when the flag is off and an app is present.
  (user-specified)
- `question`: push urgency high. When its push receives a receipt, schedule
  **one** reminder email at `question.timestamp + 10 minutes`. Send it only if
  no `output_seen` signal exists for the same `run_id` with `at` ≥ the
  question timestamp. Unwrapped (ad hoc) questions — questions with no active
  run — also get the reminder. If the reminder time has already passed when
  the receipt arrives, the reminder is evaluated and sent on the next job tick
  unless cancelled. (last clause: default, confirm)
- `stalled`: push urgency normal, sent **only** when `notify_on_phone` is true
  and an active device exists. Never email. No fallback. A `stalled` event is
  emitted after 60 seconds without agent output; it is not emitted while a
  `question` is outstanding for the same run. (thresholds: default, confirm)
- `host_silent`: always email. Push urgency high to all active devices
  regardless of the flag. (user-specified)
- A receipt means the app **received** the message, not that the user read it.
  (user-specified)

## Grouping

Bounds notification volume for chatty agents. (default, confirm)

- Grouping windows are per user and agent: 60-second windows starting at the
  first qualifying event. Counted types: `question`, `done`, `stalled`.
- Events 1–5 in a window route normally. The **6th** event sends one grouped
  message instead of an individual alert: "N events from {agent} in the last
  minute", carrying the latest event's summary.
- Events 7 and later in the window are stored but not sent.
- When a window that suppressed any events closes, send one closing message:
  "{total} events from {agent} in the last minute; {suppressed} not shown
  individually". Route it like the grouped message.
- The grouped message and the closing message are routed through the Routing
  table using the triggering event's type, with push urgency normal. If the
  triggering type is `stalled`, the grouped/closing message is push-only and
  never produces email. For `done`-triggered grouping, `email_allowed` of the
  triggering event gates the fallback email as usual.
- `failed` and `timed_out` are never counted, grouped, or suppressed — alerts
  for failures are never batched away. (user-specified)

## Deduplication

- Same user, same `run_id`, same `type`, and same `summary` within 10 minutes:
  the event is stored once and routed once. Re-submissions are reported as
  `duplicate` in the events API response. (default, confirm)
- An identical `id` is always a duplicate regardless of content.
  (user-specified — `id` is the idempotency key)

## Away flag and auto-off

- `notify_on_phone` (boolean) and `phone_alerts_since` (timestamp) are account
  state. Only the web app changes them (via `PUT /api/me/notifications`).
  (user-specified)
- Every change — including a request that sets the same value — sends a
  `state` message to all active devices. Server-side changes (auto-off, hard
  cap) also send a `state` message. (second clause: default, confirm)
- Enabling sets `notify_on_phone = true` and `phone_alerts_since = now`.
  Disabling sets `notify_on_phone = false`; `phone_alerts_since` is retained.
  `until` (returned by `GET /api/me` and sent in state messages) is
  `phone_alerts_since + 8 hours` while the flag is on, and empty when off.
  (default, confirm)
- **Auto-off on return**: while the flag is true, an `input_resumed` signal
  with `idle_seconds` ≥ 300 and `at` > `phone_alerts_since` turns the flag
  off. Input without a prior idle period (`idle_seconds` < 300), or input
  that predates `phone_alerts_since`, does nothing. (user-specified)

## Hard cap

- `notify_on_phone` turns off automatically at `phone_alerts_since + 8 hours`.
  (user-specified)
- The hard cap is enforced on the next job tick after the deadline; events
  received after the deadline are routed with the flag off.
  (default, confirm)

## Channels

Two delivery channels: web push and email. (user-specified)

- **Web push** messages are FCM **data-only** messages; every value is a
  string. Wire schema:
  [schemas/fcm-data.schema.json](schemas/fcm-data.schema.json).
- Alert keys: `type="alert"`, `event_id`, `delivery_id`, `event_type`
  (`question`, `failed`, `timed_out`, `done`, `stalled`, `host_silent`,
  `grouped`, `group_closed`), `agent`, `host`, `summary`, `run_id`,
  `timestamp`. (user-specified)
- State keys: `type="state"`, `on` (`"true"`/`"false"`), `until` (RFC 3339
  timestamp, or `""` when the flag is off), `timestamp`. (user-specified)
- Urgency is carried by the `Urgency` header in `webpush.headers`
  (RFC 8030; per the FCM HTTP v1 `WebpushConfig.headers` field): `"high"` for
  `failed`, `timed_out`, `question`, `host_silent`; `"normal"` for `done`,
  `stalled`, `grouped`, `group_closed`, and `state`. (user-specified; header
  name verified against FCM docs)
- TTL: 3600 seconds for alerts, 300 seconds for state. (user-specified)
- **Email** is plain text. Subject:
  `[agentwatch] {agent}: {event_type} on {host}`. The body contains the
  summary, `run_id`, timestamp, duration, and exit code. It never contains raw
  agent output. For `host_silent`: subject/body state
  `{host} has stopped reporting.` (user-specified)

## Privacy modes

Per-machine setting chosen at the CLI. (user-specified)

- `full` (default): the summary — after sender-side redaction — is sent to the
  server. (user-specified)
- `metadata`: the CLI sends a fixed summary such as "Question from {agent}".
  The server never sees question text or agent output. The server treats
  `summary` as opaque in all modes. (user-specified)

## Limits

Per-account and per-machine limits. (default, confirm)

- 5 machines per account.
- 5 push devices per account.
- 200 emails per account per calendar month; beyond the cap, email delivery is
  skipped (push is unaffected). Requests whose sole purpose is email
  (e.g. `POST /api/machines/current/test`) return `409` `limit_reached`.
- 60 event requests per machine per minute (`POST /api/events`); excess gets
  `429` `rate_limited` with `Retry-After`.
- 5 machine test emails per hour (`POST /api/machines/current/test`); excess
  gets `429` `rate_limited` with `Retry-After` until the email cap applies,
  then `409` `limit_reached`.

## Retention

(default, confirm)

- Events and deliveries: 30 days.
- Signals: 7 days.
- Expired device authorizations (enrollment `device_code`/`user_code`
  records): deleted after expiry.

## Versioning

- Protocol version 1. Every request carries `X-AgentWatch-Protocol: 1`; an
  unsupported version returns `426` with code `upgrade_required`. Within a
  version, changes are additive only. The CLI, server, and web app may update
  at different times. (user-specified)
- A new major protocol version requires a new header value and at least
  90 days of overlap where both versions are accepted. (user-specified)
- Full policy: [VERSIONING.md](VERSIONING.md).
