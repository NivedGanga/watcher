# Security notes — AgentWatch web app

## What lives in this browser

| Secret | Where | Scope |
|---|---|---|
| `device_secret` | IndexedDB (`agentwatch` DB, `kv` store) | Calls `POST /api/receipts` and `POST /api/devices/seen` only. Not an account credential. |
| Firebase ID token | Held by the Firebase SDK (IndexedDB-managed session) | Sent as `Authorization: Bearer` **only** to the API origin. |
| FCM registration token | Firebase SDK | Identifies this browser's push subscription to FCM. |

**Any script running on this origin can read IndexedDB, including the device
secret and anything else stored here.** That is why the app ships no
third-party scripts beyond the Firebase/Google SDK code required for auth and
messaging, and why the Content-Security-Policy keeps `script-src` to `'self'`
plus `https://www.gstatic.com` (the host the service worker's `importScripts`
needs for the Firebase compat builds — see `NOTES.md`).

The device secret's blast radius is deliberately small: it can post receipts
and seen pings for this device only. It cannot read account data, list
machines, or change the alerts flag. Revoking the device
(`DELETE /api/devices/{id}`) kills it.

## CSP

The production CSP is served as a header from `vercel.json`. Rationale for
each non-`'self'` source:

- `script-src https://www.gstatic.com` — the service worker loads
  `firebase-app-compat.js` / `firebase-messaging-compat.js` from gstatic via
  `importScripts`. Worker CSP is taken from the worker script's own response
  headers, so this must be allowed. The page itself loads no gstatic scripts.
- `connect-src` — the API origin plus the Google hosts the Firebase SDK calls
  for auth (`identitytoolkit`, `securetoken`, `www.googleapis.com`) and FCM
  (`firebaseinstallations`, `fcmregistrations`, `fcm`, `firebaselogging`).
- `frame-src https://*.firebaseapp.com` — Firebase Auth loads a hidden
  helper iframe at `https://<authDomain>/__/auth/iframe` for popup/redirect
  sign-in. With a custom `authDomain`, add that host instead/in addition.
- `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`,
  `form-action 'self'` — hardening.
- No `unsafe-inline` and no `eval` anywhere. All code is bundled first-party.

If `VITE_API_BASE_URL` points somewhere other than
`https://api.alerts.example.com`, update `connect-src` in `vercel.json` to
match — the two must stay in sync.

## Logging

The app never logs tokens, device secrets, ID tokens, user codes, or push
message bodies. The test suite spies on `console.*` and asserts secrets never
appear.
