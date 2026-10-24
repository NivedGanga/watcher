# NOTES

Deviations, ambiguities, unverified APIs, and known gaps. Rule followed: when
the build prompt and `spec/` disagreed, `spec/` won and the conflict is
recorded here.

## Conflicts resolved (spec/ wins)

1. **Server-side re-redaction.** The prompt asked to re-apply
   `spec/redaction.json` to `summary` at ingest ("defense in depth") and to
   test that each pattern is removed. `SPEC.md` (Event model) says the server
   "treats `summary` as opaque text and does not re-redact." Spec wins: the
   server does **not** re-redact, and the corresponding test is not
   implemented. `spec/redaction.json` is vendored for reference only.

2. **Vercel Cron uses GET.** `api.md` defines `POST /api/jobs/tick`, but
   Vercel Cron only issues `GET` requests (verified in Vercel docs). The
   endpoint accepts both: `POST` requires `X-AgentWatch-Protocol: 1` (per
   VERSIONING.md), `GET` is exempt from the protocol header since Vercel Cron
   cannot set custom headers; both require `Authorization: Bearer
   ${CRON_SECRET}` (Vercel sends it automatically when `CRON_SECRET` is set).

3. **`grouping_sixth_event` fixture.** `routing-cases.json` expects
   `emails: []` there, but its third event is a `question` with
   `receipt_within_120s: true`. SPEC.md requires a receipt on a question to
   schedule the +10 min reminder email (which fires — no `output_seen`
   exists). Per `spec/conformance/README.md`, SPEC.md wins over fixtures; the
   conformance test asserts the SPEC.md behavior for this one case and the
   divergence is reported here.

4. **`client_name`/`client_os` length.** `api.md` allows 1–128 chars; the
   prompt's normalization caps at 64. Implemented: validate 1–128 on the raw
   value, strip control characters, store truncated to 64.

5. **`/api/device/pending` response.** The prompt lists `requested_at` among
   returned fields; the `api.md` example omits it. Included anyway — new
   response fields are additive under the versioning policy.

6. **Events on a deleted machine.** `api.md` lists `404 (deleted machine)`
   under `/api/events` errors; the prompt says unknown/revoked/malformed keys
   return `401` with no detail. Implemented `401` (authentication fails before
   routing).

## Decisions on ambiguities

- **Approve+deny rate limit** ("30 per hour" for both) is a single shared
  bucket per user.
- **Machine limit at token redemption**: if the limit is hit between approve
  and poll, the poll returns `access_denied` — RFC 8628 has no better code.
- **Grouped/closing messages on a question trigger** route through the table
  like a question (fallback/immediate email applies) but do not schedule the
  question reminder.
- **Grouped summary** = `"{N} events from {agent} in the last minute:
  {latest event's summary}"`; closing uses the exact spec sentence.
- **Closing message event linkage**: deliveries for `group_closed` reference
  the window's `latest_event_id`; `groups.trigger_event_id` (extra column)
  records the 6th event for routing/urgency/email gating.
- **Device re-registration** of an existing FCM token rotates the secret and
  clears `revoked_at` (re-registration is treated as intent to use the device).
- **`host_silent` email subject**: `[agentwatch] {host} has stopped
  reporting.`; body repeats the sentence plus machine/time.
- **Hard cap** is enforced on the tick, and also evaluated at route time
  (effective flag) per SPEC: "events received after the deadline are routed
  with the flag off."
- **"Computers page" link** in the connected email = `{APP_URL}/computers`.
- **Tuple dedupe window**: |Δevent_timestamp| ≤ 600 s.
- **Approving a pending code**: codes are not user-bound until approval (RFC
  8628 model); any verified user with the user_code can approve.

## Verified external APIs (checked during build)

- **Hono on Vercel**: current Vercel docs detect a Hono entry file at
  `index.ts`/`src/index.ts`/`src/app.ts` (etc.) with `export default app`;
  used `index.ts` → `createApp(...)`. The classic alternative is
  `api/index.ts` + `handle(app)` from `hono/vercel` + rewrites.
- **Vercel Cron**: Hobby = once per day (per-hour precision); Pro/Enterprise =
  once per minute. Sends `Authorization: Bearer ${CRON_SECRET}` when the env
  var is set, plus `x-vercel-cron-schedule` and `vercel-cron/1.0` UA — GET
  only, no custom headers.
- **firebase-admin messaging**: `messaging().send({token, data,
  webpush:{headers}})`; `headers` are `Record<string,string>` — `Urgency`
  (`high`/`normal`, RFC 8030) and `TTL` (seconds as string). Unregistered
  token → error code `messaging/registration-token-not-registered`.
- **Resend**: `new Resend(key).emails.send({from, to:[addr], subject, text})`.
- **Drizzle + Neon**: `drizzle-orm/neon-http` does not support transactions
  (needed for row locks and atomic redemption), and `neon-serverless`
  (WebSocket pool) needs a `ws` polyfill. Used `drizzle-orm/postgres-js`
  against the Neon **pooled** endpoint at runtime — same code path as the
  local docker Postgres in tests. Trade-off: TCP connections per cold start
  instead of HTTP/WebSocket transport; Neon pooled endpoint mitigates this.
  Use a direct (non-pooled) URL for migrations.

## Known gaps / characteristics

- The tick runs about once a minute, so all scheduled work (fallbacks,
  reminders, group close, silence detection, retention) has ~1-minute
  precision.
- A machine that sleeps/hibernates while it has an active run will still
  alert (`host_silent`) after 15 minutes without a heartbeat.
- "Immediate" emails (flag off, no app) and state pushes are sent on the next
  tick — up to ~1 minute after the trigger.
- Schema additions beyond the spec'd field list: `deliveries.payload` (push
  payload/audit), `jobs.dedupe_key` + `jobs.created_at`, `groups.trigger_event_id`.
- Deliveries are claimed optimistically (`attempts+1` then send); a crash
  between send and status update could re-send a push/email — providers do not
  dedupe downstream.
- Self-hosted adapters are not implemented; the four interfaces
  (`AuthProvider`, `PushProvider`, `EmailProvider`, `JobRunner`) isolate the
  hosted adapters for a future swap.
- `DELETE /api/me` deletes all rows and revokes credentials; the Firebase
  account itself is deleted by the web app (documented in README).

## Storage engine: Postgres → MongoDB (2026-10-25)

The server now runs on MongoDB instead of Postgres + Drizzle. The change is
contained in the data layer; routes, routing, and worker code are untouched.

- `repo.ts` keeps its function signatures; `Q` is now `{db, session?}` and
  `Database.transaction()` wraps `session.withTransaction` (the driver
  retries on TransientTransactionError).
- `lockUser`/`lockAuthBy*` became write-touches inside the transaction —
  a concurrent transaction on the same doc fails with a write conflict and
  the callback retries, matching the old `SELECT ... FOR UPDATE` semantics.
- `FOR UPDATE SKIP LOCKED` job claiming became per-document atomic
  `findOneAndUpdate` in a loop.
- Composite PKs became compound `_id`s (`${userId}:${id}`,
  `${userId}:${agent}:${windowStartISO}`); `ON CONFLICT` became unique
  indexes + duplicate-key (11000) handling; the deliveries unique triplet
  uses a materialized `dedupe` field.
- `rate_limits` upsert-CASE became a pipeline `findOneAndUpdate` with `$cond`.
- Multi-document transactions require a replica set: local dev runs a
  single-node `rs0` (docker compose `mongo` + `mongo-init`); production
  expects Atlas. `DATABASE_URL` now holds a `mongodb://`/`+srv` URI.
- `drizzle/`, `drizzle.config.ts`, `src/db/schema.ts`, and the `drizzle-orm`/
  `postgres`/`drizzle-kit` deps were removed; collections + indexes are
  created by `src/db/indexes.ts` via `npm run db:migrate`.
