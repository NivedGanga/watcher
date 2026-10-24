# AgentWatch API

Base: `https://<host>/api`. All request and response bodies are JSON
(`Content-Type: application/json`) unless noted. Timestamps are RFC 3339 UTC
ending in `Z`. All rules referenced below are defined in
[SPEC.md](SPEC.md).

## Common requirements

- **Protocol header.** Every request to every endpoint carries
  `X-AgentWatch-Protocol: 1`. A missing or unsupported version returns `426`
  with code `upgrade_required`. See [VERSIONING.md](VERSIONING.md).
- **Error shape.** All errors except RFC 8628 device-flow token errors use:

  ```json
  {"error": {"code": "unauthorized", "message": "human-readable detail"}}
  ```

- **Error codes.**

  | HTTP | code | Meaning |
  |---|---|---|
  | 400 | `validation_failed` | Body or parameters fail validation (including unknown fields). |
  | 401 | `unauthorized` | Missing, malformed, or invalid credential. |
  | 403 | `forbidden` | Valid credential, not allowed for this resource/action. |
  | 403 | `email_not_verified` | Account email is not verified; required for every account action. |
  | 404 | `not_found` | Resource does not exist (or is not visible to this credential). |
  | 409 | `limit_reached` | Account limit exceeded (machines, devices, monthly email cap). |
  | 426 | `upgrade_required` | Missing/unsupported `X-AgentWatch-Protocol` version. |
  | 429 | `rate_limited` | Rate limit exceeded; response includes `Retry-After` (seconds). |

- `POST /api/device/token` is the one exception: it uses the RFC 8628 error
  shape `{"error": "authorization_pending"}` (see below).

## Authentication summary

| Credential | Header | Used by |
|---|---|---|
| Firebase ID token | `Authorization: Bearer <id_token>` | Web app endpoints |
| Machine key | `Authorization: Bearer aw_<machine_id>_<secret>` | Machine endpoints |
| Device secret | `Authorization: Device <device_id>.<device_secret>` | Browser endpoints |
| Cron secret | `Authorization: Bearer ${CRON_SECRET}` | `POST /api/jobs/tick` |

Web app endpoints additionally require a **verified** account email; otherwise
`403 email_not_verified`.

---

## Web app (Firebase ID token)

### `GET /api/me`

Returns account state.

- **Response `200`**
  ```json
  {
    "notify_on_phone": true,
    "phone_alerts_since": "2026-01-01T08:00:00Z",
    "until": "2026-01-01T16:00:00Z",
    "email": "user@example.com",
    "active_device_count": 2,
    "machine_count": 3
  }
  ```
  `until` = `phone_alerts_since + 8 hours` while the flag is on; `null` when
  off or when `phone_alerts_since` is unset.
- **Errors:** `401 unauthorized`, `403 email_not_verified`.

### `PUT /api/me/notifications`

Sets the away flag.

- **Request:** `{"enabled": true}` (boolean, required; no other fields).
- Enabling sets `notify_on_phone = true`, `phone_alerts_since = now`.
  Disabling sets `notify_on_phone = false`. Every call — including one with
  the current value — pushes a `state` message to all active devices.
- **Response `200`:** `{"notify_on_phone": true, "phone_alerts_since": "...", "until": "..."}`.
- **Errors:** `400 validation_failed`, `401`, `403 email_not_verified`.

### `DELETE /api/me`

Deletes the account and all associated data (machines, devices, events,
signals, deliveries). Immediate and irreversible.

- **Response `204`** (no body).
- **Errors:** `401`, `403 email_not_verified`.

### `GET /api/me/machines`

Lists the account's machines.

- **Response `200`**
  ```json
  [
    {"id": "m_abc123", "name": "workstation", "os": "macos",
     "last_heartbeat_at": "2026-01-01T09:59:12Z", "active_runs": 1}
  ]
  ```
- **Errors:** `401`, `403 email_not_verified`.

### `DELETE /api/me/machines/{id}`

Removes a machine and invalidates its key.

- **Response `204`**.
- **Errors:** `401`, `403 email_not_verified`, `404 not_found`.

### `POST /api/devices`

Registers a push device.

- **Request:** `{"fcm_token": "..."}` (string, required; no other fields).
- **Response `201`:** `{"device_id": "d_xyz", "device_secret": "..."}`.
  `device_secret` is returned exactly once. Registering an `fcm_token` that is
  already registered rotates the secret: same `device_id`, new
  `device_secret`; previous secrets stop working immediately.
- **Errors:** `400 validation_failed`, `401`, `403 email_not_verified`,
  `409 limit_reached` (>5 devices).

### `DELETE /api/devices/{id}`

Revokes a push device (sets `revoked_at`).

- **Response `204`**.
- **Errors:** `401`, `403 email_not_verified`, `404 not_found`.

### `GET /api/device/pending?user_code=`

Looks up a pending enrollment for approval UI. `user_code` matching is
case-insensitive and accepts input with or without the dash.

- **Response `200`:**
  `{"user_code": "XKCD-9W2P", "client_name": "workstation", "client_os": "macos", "expires_at": "..."}`.
- **Errors:** `400 validation_failed`, `401`, `403 email_not_verified`,
  `404 not_found` (unknown, expired, or already decided code).

### `POST /api/device/approve`

- **Request:** `{"user_code": "XKCD-9W2P"}`.
- Marks the pending request approved; the CLI's next token poll succeeds. Sends
  the "New computer connected" email to the verified address.
- **Response `200`:** `{"approved": true}`.
- **Errors:** `400 validation_failed`, `401`, `403 email_not_verified`,
  `404 not_found`, `409 limit_reached` (>5 machines).

### `POST /api/device/deny`

- **Request:** `{"user_code": "XKCD-9W2P"}`.
- Marks the pending request denied; the CLI's next token poll returns
  `access_denied`.
- **Response `200`:** `{"approved": false}`.
- **Errors:** `400 validation_failed`, `401`, `403 email_not_verified`,
  `404 not_found`.

---

## Browser (device secret)

Auth: `Authorization: Device <device_id>.<device_secret>`.

### `POST /api/receipts`

Records that a push delivery was received by the app. Updates the device's
`last_seen_at`. A receipt suppresses the 2-minute email fallback for that
event and, for `question` events, schedules the reminder email.

- **Request:** `{"delivery_id": "..."}` (string, required).
- **Response `204`**.
- **Errors:** `400 validation_failed`, `401`, `404 not_found` (unknown
  delivery or revoked device).

### `POST /api/devices/seen`

The "seen ping": the app is alive. Updates `last_seen_at`.

- **Request:** `{}` (empty object).
- **Response `204`**.
- **Errors:** `401`, `404 not_found` (revoked device).

---

## Enrollment (no auth)

### `POST /api/device/start`

Begins RFC 8628 device authorization.

- **Request:** `{"client_name": "workstation", "client_os": "macos"}`
  (both strings, 1–128 chars, required; no other fields).
- **Response `200`:**
  ```json
  {
    "device_code": "...",
    "user_code": "XKCD-9W2P",
    "verification_uri": "https://<host>/connect",
    "verification_uri_complete": "https://<host>/connect?user_code=XKCD-9W2P",
    "expires_in": 600,
    "interval": 5
  }
  ```
- **Errors:** `400 validation_failed`, `429 rate_limited`.

### `POST /api/device/token`

RFC 8628 token poll. **This endpoint uses the RFC 8628 error shape**
`{"error": "<code>"}`, not the common error envelope.

- **Request:** `{"device_code": "..."}`.
- **Success `200` (returned exactly once, at the poll after approval):**
  `{"machine_id": "m_abc123", "key": "aw_m_abc123_<secret>"}`.
  The `key` is created at this poll, not at approval. Store it locally; it is
  never shown again.
- **Error responses:**
  - `{"error": "authorization_pending"}` — not yet approved; keep polling at
    the current interval.
  - `{"error": "slow_down"}` — polling too fast; increase the interval by
    5 seconds.
  - `{"error": "access_denied"}` — the user denied the request, or the
    `device_code` was already redeemed.
  - `{"error": "expired_token"}` — `device_code` expired (600 s) or is
    unknown; start over.

---

## Machine (machine key)

Auth: `Authorization: Bearer aw_<machine_id>_<secret>`.

### `POST /api/events`

- **Request:** `{"events": [<event>, ...]}` — 1–50 events conforming to
  [schemas/event.schema.json](schemas/event.schema.json); the serialized body
  must be ≤ 64 KB.
- **Response `202`** — one result per submitted event, in order:
  ```json
  {"results": [
    {"id": "uuid", "status": "accepted"},
    {"id": "uuid", "status": "duplicate"},
    {"id": "uuid", "status": "rejected", "reason": "summary exceeds 200 chars"}
  ]}
  ```
  `accepted` = stored and queued for routing; `duplicate` = same `id`, or same
  (user, `run_id`, `type`, `summary`) within 10 minutes — stored once, routed
  once; `rejected` = failed validation, with a `reason`.
- **Errors:** `400 validation_failed` (malformed body), `401`, `404` (deleted
  machine), `413`-equivalent `validation_failed` (>64 KB), `429 rate_limited`
  (>60 requests/minute).

### `POST /api/signals`

- **Request:** `{"signals": [<signal>, ...]}` — 1–50 signals conforming to
  [schemas/signal.schema.json](schemas/signal.schema.json).
- **Response `202`:** `{"results": [{"id": "...", "status": "accepted"}, ...]}`
  — same result shape as `/api/events`.
- **Errors:** `400 validation_failed`, `401`, `404`, `429 rate_limited`.

### `POST /api/heartbeat`

- **Request:** `{"sent_at": "2026-01-01T10:00:00Z", "active_runs": 2}` per
  [schemas/heartbeat.schema.json](schemas/heartbeat.schema.json).
- **Response `204`**. A heartbeat ends any open silence episode.
- **Errors:** `400 validation_failed`, `401`, `404`, `429 rate_limited`.

### `POST /api/machines/current/test`

Sends the setup/test email for this machine to the verified account address.

- **Request:** `{}`.
- **Response `202`:** `{"sent": true}`.
- **Errors:** `401`, `403 email_not_verified`, `404`, `409 limit_reached`
  (monthly email cap), `429 rate_limited` (>5/hour).

### `DELETE /api/machines/current`

The machine removes itself and invalidates its key.

- **Response `204`**.
- **Errors:** `401`, `404`.

---

## Jobs (internal)

### `POST /api/jobs/tick`

Drives scheduled work: the 15-minute silence detector, the 2-minute email
fallback, question reminders, grouping window close-out, auto-off, and the
8-hour hard cap. **Internal — not part of the public protocol.**

- **Auth:** `Authorization: Bearer ${CRON_SECRET}`.
- **Request:** `{}`.
- **Response `200`:** `{"ok": true}`.
- **Errors:** `401 unauthorized`.
