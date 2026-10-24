# NOTES — implementation decisions, verification status, conflicts

Last updated: 2026-10-25.

## Prompt ↔ spec conflicts / gaps (spec wins)

- **Approval page "requested time".** The prompt asks the approval page to
  show "the computer name, OS, requested time". `GET /api/device/pending`
  returns only `user_code`, `client_name`, `client_os`, `expires_at` — there is
  no request-time field. The page shows "Code expires" from `expires_at`
  instead.
- **Grouped notification counts.** The required titles are
  `"{N} events from {agent}"` and `"{N} events from {agent}; {suppressed} not
  shown"`, but the FCM alert payload (spec/schemas/fcm-data.schema.json) has no
  count fields — only `summary`, which carries the counts as text
  (`"6 events from {agent} in the last minute"`,
  `"9 events from {agent} in the last minute; 3 not shown individually"`). The
  counts are parsed out of `summary`; if the server ever changes the summary
  wording, titles fall back to `"Events from {agent}"`. A dedicated payload
  field would be more robust — flag for the server/protocol owner.
- **`"post the event_id"` on notificationclick.** The SW posts a message
  containing the `event_id` **and** the full alert payload, so an already-open
  window can render the alert in the session list. An ID alone is
  undisplayable; there is no event-fetch endpoint.
- **404 for approve/deny covers unknown, expired, *and* already-decided codes**
  (per api.md), so the UI cannot distinguish "not found" from "expired". One
  message covers both.
- **"Alerts on until HH:MM"** shows the `until` time in local time; when `until`
  is absent/invalid the line reads "Alerts off".

## Verified against current docs

- **FCM on the web** (firebase.google.com/docs/cloud-messaging/js/client and
  /docs/reference/js/messaging): `getToken(messaging, { vapidKey,
  serviceWorkerRegistration })`. If no registration is passed, the SDK looks
  for a service worker at `/firebase-messaging-sw.js` — we serve exactly that
  path at root scope **and** pass the registration explicitly.
  `onBackgroundMessage` is the SW-side handler; `onMessage` is the
  foreground handler. Data-only messages reach `onBackgroundMessage` with no
  automatic notification — we always show one ourselves.
- **Modular vs compat in the SW.** The messaging docs state the modular SDK
  needs a bundler in service workers; otherwise use the compat (namespaced)
  builds via `importScripts`. We use the compat builds from
  `https://www.gstatic.com/firebasejs/<ver>/firebase-{app,messaging}-compat.js`
  pinned to the same version as the page's `firebase` package.
- **PWA installability.** Chrome removed the service-worker `fetch` handler
  requirement for menu install (mobile 108 / desktop 112), but the
  install-promotion heuristics still use it, so `/firebase-messaging-sw.js`
  includes a **pass-through** `fetch` handler with no caching. Manifest
  requirements (`name`/`short_name`, `start_url`, `display`, 192 + 512 icons)
  are met; `maskable` 512 included for Android.
- **Chrome for Android push.** Chrome uses FCM as its push service, so push
  requires Google Play services on the device. Battery-restricted Chrome can
  delay or drop delivery — covered in the README checklist. Web push needs a
  service worker + `Notification` permission; HTTPS everywhere.
- **iOS.** Web push requires the PWA to be installed to the Home Screen
  (Safari 16.4+); the app detects iOS-outside-standalone and says so instead
  of offering a button that would fail.

## Not fully verified — assumptions to re-check before launch

- **CSP host list.** Firebase publishes no official CSP whitelist for
  auth+messaging. `connect-src` lists the endpoints the SDK is known to call
  (identitytoolkit, securetoken, www.googleapis.com, firebaseinstallations,
  fcmregistrations, fcm, firebaselogging). `firebaselogging.googleapis.com`
  may be unnecessary (SDK diagnostics; blocking it should degrade gracefully).
  `frame-src https://*.firebaseapp.com` covers the default `*.firebaseapp.com`
  authDomain helper iframe; a custom `VITE_FIREBASE_AUTH_DOMAIN` needs its own
  host added. Verify against a real sign-in + push on staging.
- **`script-src https://www.gstatic.com`** exists only for the service
  worker's `importScripts` (worker CSP comes from its script's response
  headers). If the header can be scoped per-path later, restrict it to the SW.
- **Group-title parsing** (above) depends on the server summary wording.

## Version choices

- `firebase@12.19.0` (published 2026-09-09). `firebase@13.0.0` exists but its
  sub-packages declare `node >=24.12` while this environment has Node 22.19,
  and `13.1.0` was released <7 days before this work. The SW imports the same
  version's compat builds from gstatic (URL verified to return 200).
- `vite@8.3.4`, `vitest@5.0.5`, `react@19.3.0`, `react-router-dom@7.18.4`,
  `typescript@5.9.3` — all ≥7 days old at install time, pinned exactly
  (`save-exact` in `.npmrc`).
- `npm audit` flags `@grpc/grpc-js` via `@firebase/firestore`: the app never
  imports Firestore and gRPC is not part of the browser bundle. Accepted.

## Architecture notes

- **One source of push logic.** `src/shared/awsw.ts` is the single
  implementation of notification titles, the flag-state reducer, receipts, and
  the outbox. `scripts/build-sw.mjs` bundles it to `public/awsw.js` (IIFE,
  `self.AgentWatchSW`) and injects `AGENTWATCH_API_BASE` + the Firebase config;
  `/firebase-messaging-sw.js` (static, unbundled) `importScripts`es it. The
  page and the tests import the same module directly — tests cover the shipped
  logic, not a copy.
- **IndexedDB helper** is a ~60-line wrapper (`src/lib/kv.ts`) used by both the
  page and the SW — the "similar" option instead of idb-keyval, so the SW
  needs no extra scripts. One DB (`agentwatch`/`kv`) holds device credentials,
  the receipt outbox, flag state, and the seen-ping timestamp.
- **Device secret in IndexedDB** — see `docs/security.md`. Any script on this
  origin could read it; that is why there are no third-party scripts beyond
  Firebase/Google.
- **Sign-in** uses `signInWithPopup`; on popup-blocked/cancelled it falls back
  to `signInWithRedirect` after saving the current path+query to
  `sessionStorage` so `/device?user_code=` survives the round trip.
- **Foreground messages** go through the same `handlePushData` path as the SW
  (notification via `registration.showNotification`, receipt with retry).
- **`?alert=<event_id>`** opened by a notification click with no live window
  shows a notice, not alert details — the recent-alerts list is session
  memory only, per spec.
- **Icons are generated placeholders** (`scripts/generate-icons.mjs`, solid
  brand color). Replace before launch.
- **No Playwright smoke test** (optional per brief); coverage is Vitest + RTL.

## Env/build

- Missing `VITE_*` vars fail at three points with the variable name:
  `vite.config.ts` (dev/build), `scripts/build-sw.mjs` (predev/prebuild), and
  `loadConfig` at runtime.
- `.env.local` is gitignored (`.env*` in the root `.gitignore`);
  `.env.example` documents the variables.
- `public/awsw.js` is generated and gitignored; `predev`/`prebuild`
  regenerate it.
- The CSP in `vercel.json` hardcodes the API origin
  `https://api.alerts.example.com` — keep it in sync with
  `VITE_API_BASE_URL` if the API moves.
