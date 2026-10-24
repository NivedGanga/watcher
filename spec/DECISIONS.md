# Decisions

Every rule in [SPEC.md](SPEC.md) is either **user-specified** (given directly)
or **default (confirm)** (chosen conservatively where the brief was ambiguous;
confirm before building on it). One line of rationale each.

## Authentication

- Firebase ID token in `Authorization: Bearer` — **default (confirm)**: the brief
  requires the token but not the header; Bearer is the Firebase convention.
- Email verified for every account action — **user-specified**.
- Machine key `Bearer aw_<machine_id>_<secret>`, shown once, stored hashed —
  **user-specified**.
- Device secret `Device <device_id>.<device_secret>`, receipts + seen ping only —
  **user-specified**.
- Constant-time credential comparison, no credential logging —
  **default (confirm)**: standard hygiene for a public service.

## Event model

- All listed fields, limits, and UUID v4 `id` as idempotency key —
  **user-specified**.
- Unknown fields rejected — **user-specified**.
- CLI types and `blocking` assignment — **user-specified**.
- `host_silent` backend-created; `started` never sent — **user-specified**.
- Sender-side redaction only; server treats summary as opaque —
  **default (confirm)**: privacy modes require trusting the sender's summary.

## Signals

- Field set and `run_id`/`idle_seconds` conditionality — **user-specified**.

## Heartbeat

- `sent_at` + `active_runs ≥ 0` — **user-specified**.
- 60-second heartbeat interval — **default (confirm)**: the brief defines the
  15-minute silence window but no send interval; 60 s gives 15× margin.

## Devices and presence

- `revoked_at`/`last_seen_at`, FCM not-registered revokes, `last_seen_at`
  updates on receipts and the seen ping — **user-specified**.
- "App signed in" = ≥1 active device; signed-in browser without notification
  permission doesn't count — **default (confirm)** (as flagged in the brief).
- Stale boundary: age strictly < 14 days counts as active; exactly 14 days is
  stale — **default (confirm)**: "within 14 days" read as exclusive of the edge,
  matching the routing case `device_stale_at_14_days`.

## Machine enrollment

- RFC 8628 flow, response fields, `expires_in` 600, `interval` 5,
  8-char `user_code` from a no-`0/O/1/I` alphabet shown `XXXX-XXXX`,
  case-insensitive dash-optional matching, hashed storage, token poll errors,
  key created at the poll and returned exactly once, pending/approve/deny
  endpoints, approval email — **user-specified**.
- Alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — **default (confirm)**:
  concrete instantiation of "no 0, O, 1, I" (24 letters + digits 2–9).
- Already-redeemed `device_code` → `access_denied` — **default (confirm)**:
  RFC 8628 defines no post-redemption error; reusing `access_denied` keeps the
  error set closed.
- Machine limit enforced at approval → `409 limit_reached` —
  **default (confirm)**: approval is the last point before a machine exists.

## Machines

- 15-minute silence threshold, `host_silent` once per episode —
  **user-specified**.
- Silent with last `active_runs = 0` → marked silent, no alert —
  **default (confirm)** (as flagged in the brief).
- Silence episode ends on the next heartbeat — **default (confirm)**:
  needed to bound "once per episode".
- `host_silent` carries last `run_id` or `none`, summary
  "{host} has stopped reporting." — **default (confirm)**.

## Routing

- The 2×2 table for `question`, `failed`, `timed_out`, `done` —
  **user-specified**.
- Any receipt suppresses the fallback email — **user-specified**.
- Fallback window measured from push send — **default (confirm)**.

## Modifiers

- `done`: `email_allowed` gates email; normal urgency — **user-specified**.
- `failed`/`timed_out`: high urgency; `email_allowed` ignored —
  **user-specified**.
- **Known trade-off (user-specified):** under the table, `failed` and
  `timed_out` produce nothing when the flag is on with no app, and nothing
  when the flag is off with an app present. Accepted: the flag means "only
  alert my phone when I'm away", and email-only users get failures when they
  have no registered app at all.
- `question`: high urgency; one reminder at question timestamp + 10 min on
  receipt; cancelled by `output_seen` for the same `run_id` at ≥ question
  timestamp; ad hoc questions included — **user-specified**.
- Reminder fired late (receipt after the deadline) is sent on the next tick
  unless cancelled — **default (confirm)**.
- `stalled`: normal urgency, only flag-on + active device, never email, no
  fallback — **user-specified**.
- `stalled` threshold: 60 s without output; suppressed while a question is
  outstanding for the run — **default (confirm)**.
- `host_silent`: always email + high-urgency push regardless of flag —
  **user-specified**.
- Receipt = delivered, not read — **user-specified**.

## Grouping

- Per user+agent 60-s windows from the first qualifying event; counted types
  `question`, `done`, `stalled`; 1–5 normal, 6th grouped, 7+ stored-only;
  closing message on window close — **default (confirm)** (mechanism given,
  flagged as default in the brief).
- Grouped/closing messages route through the table as their triggering type
  (urgency normal; `stalled`-triggered groups are push-only; `done`-triggered
  groups respect `email_allowed`) — **default (confirm)**: "route it like the
  grouped message" needed a concrete rule.
- `failed`/`timed_out` never counted — **user-specified**.

## Deduplication

- Same user + `run_id` + `type` + `summary` within 10 min → stored once,
  routed once — **default (confirm)** (as flagged in the brief).
- Identical `id` always duplicates — **user-specified** (idempotency key).

## Away flag and auto-off

- Fields, web-app-only writes, state message on every change (including
  same-value), auto-off on `input_resumed` with `idle_seconds` ≥ 300 and
  `at` > `phone_alerts_since`, idle < 300 does nothing — **user-specified**.
- Enabling sets `phone_alerts_since = now`; `until` = `phone_alerts_since` +
  8 h when on — **default (confirm)**: needed to define `until`.
- Server-side changes (auto-off, hard cap) also emit a state message —
  **default (confirm)**: "every change" read to include non-web-app causes.

## Hard cap

- Flag off at `phone_alerts_since` + 8 h — **user-specified**.
- Enforced on the next job tick — **default (confirm)**.

## Channels

- Data-only push with all-string values; alert/state key sets — **user-specified**.
- `Urgency` header in `webpush.headers` (RFC 8030), high/normal mapping —
  **user-specified**; header name verified against FCM HTTP v1 docs.
- TTL 3600 alerts / 300 state — **user-specified**.
- Email subject/body contents, no raw output, host_silent wording —
  **user-specified**.

## Privacy modes

- `full` (default) sends the redacted summary; `metadata` sends a fixed
  summary; server treats summary as opaque — **user-specified**.

## Limits

- 5 machines, 5 push devices, 200 emails/month, 60 event
  requests/machine/minute, 5 test emails/hour — **default (confirm)**
  (values given, flagged as default in the brief).
- Email cap skips delivery but leaves push unaffected — **default (confirm)**.

## Retention

- Events/deliveries 30 days, signals 7 days, expired device authorizations
  deleted after expiry — **default (confirm)** (as flagged in the brief).

## Versioning

- `X-AgentWatch-Protocol: 1` on every request; 426 `upgrade_required` for
  unsupported versions; additive-only within a version; independent updates;
  new major = new header value + ≥90 days overlap — **user-specified**.
