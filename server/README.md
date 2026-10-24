# AgentWatch API

Hosted API for AgentWatch (protocol v1). TypeScript, Hono on Vercel Functions,
MongoDB, Firebase Auth + FCM push, Resend email.

Implements `spec/SPEC.md` and `spec/api.md`. See `NOTES.md` for deviations,
ambiguities, and operational details.

## Layout

- `index.ts` — Vercel entry (default-exports the Hono app; Vercel's Hono
  support wraps `app.fetch` as a Function).
- `src/app.ts` — app assembly (CORS, protocol header, error envelope).
- `src/routes/` — endpoint handlers.
- `src/repo.ts` — the only module that queries the database (MongoDB);
  every query is scoped by the authenticated principal's `user_id`.
- `src/routing/route.ts` — pure routing function (spec routing table,
  modifiers, grouping) tested against `spec/routing-cases.json`.
- `src/worker/` — delivery execution and the jobs tick.
- `src/providers/` — hosted adapters behind interfaces (`AuthProvider`,
  `PushProvider`, `EmailProvider`, `JobRunner`) so self-hosted adapters can be
  added later.
- `src/db/indexes.ts` — collections + indexes; `src/db/migrate.ts` applies them.
- `spec/` — vendored protocol artifacts used at runtime and in tests.

## Local development

```
npm install
docker compose up -d mongo mongo-init  # single-node replica set on :27017 (needed for transactions)
DATABASE_URL='mongodb://localhost:27017/agentwatch_test?replicaSet=rs0&directConnection=true' npm run db:migrate
npm test                               # vitest (needs the docker db)
npm run typecheck
npm run dev                            # local server on :3000 (needs .env)
```

## Production setup

### 1. MongoDB Atlas

1. Create an Atlas cluster (M0+ works; any replica set does — transactions are
   required, so standalone or non-replicated deployments will not work).
2. Copy the SRV connection string into `DATABASE_URL` for the API project's
   env vars, e.g.
   `mongodb+srv://user:pass@cluster.mongodb.net/agentwatch`.
3. Create collections and indexes once:
   `DATABASE_URL=<connection-string> npm run db:migrate`

### 2. Firebase

1. Create a Firebase project; enable **Google** sign-in provider.
2. Project settings → Service accounts → Generate new private key. Base64-encode
   the JSON file (`base64 -i serviceAccountKey.json`) into
   `FIREBASE_SERVICE_ACCOUNT_JSON_B64`.
3. `FIREBASE_PROJECT_ID` = the project id.
4. Add `DOMAIN` (the web app origin) to Authentication → Authorized domains.

### 3. Resend

1. Verify your sending domain at resend.com/domains.
2. Create an API key → `RESEND_API_KEY`.
3. `EMAIL_FROM` = e.g. `AgentWatch <alerts@yourdomain>`.

### 4. Secrets

```
DEVICE_TOKEN_ENC_KEY: openssl rand -base64 32     # AES-256-GCM, must decode to 32 bytes
MACHINE_KEY_PEPPER:   openssl rand -hex 32        # HMAC key for all stored credential hashes
CRON_SECRET:          openssl rand -hex 16        # Bearer token for /api/jobs/tick
```

### 5. Vercel projects

Two Vercel projects from this one repo — do **not** use a single project with
rewrites:

- **API project** → root directory `server/`, domain `api.DOMAIN`.
- **Web project** → root directory `web/`, domain `DOMAIN`.

Set the env vars above on the **API** project. `CORS_ORIGIN` must be the web
origin (`https://DOMAIN`), `APP_URL` likewise (used for verification links).

### 6. The one-minute tick

`POST /api/jobs/tick` drives all scheduled work and must run about once a
minute, authenticated with `Authorization: Bearer ${CRON_SECRET}`.

- **Vercel Cron (Pro/Enterprise):** `vercel.json` already contains
  `crons: [{path: "/api/jobs/tick", schedule: "* * * * *"}]`. Vercel calls the
  path with a **GET** request carrying `Authorization: Bearer ${CRON_SECRET}`
  automatically once `CRON_SECRET` is set as an env var. The endpoint accepts
  GET for this reason.
- **Hobby plan:** cron jobs are limited to **once per day** and deploy will
  fail for `* * * * *` — remove the `crons` block from `vercel.json` and use an
  external scheduler (e.g. cron-job.org) that POSTs every minute to
  `https://api.DOMAIN/api/jobs/tick` with headers
  `Authorization: Bearer <CRON_SECRET>` and `X-AgentWatch-Protocol: 1`.

### 7. Healthcheck

Create an external check (e.g. healthchecks.io) that expects a ping every
~2 minutes. Put its ping URL in `HEALTHCHECK_URL`; the API pings it after each
successful tick.

### 8. Deploy

`git push` (or `vercel deploy`) on both projects. The web app at `DOMAIN`
deletes the Firebase account and signs the user out after calling
`DELETE /api/me` — the API deletes all server-side rows and revokes
credentials; Firebase account deletion is client-side.
