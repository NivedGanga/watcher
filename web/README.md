# AgentWatch web app

The AgentWatch phone app: a progressive web app that signs the user in, shows
and changes the phone-alerts flag, registers the browser for push, receives
alerts, sends receipts, approves computers, and manages the account.

Stack: Vite, React, TypeScript (strict), Firebase JS SDK (auth + messaging),
a tiny IndexedDB helper, Vitest + React Testing Library. Protocol version 1 —
every API call sends `X-AgentWatch-Protocol: 1` (see `../spec/api.md`).

## Local development

```sh
cd web
cp .env.example .env.local   # fill in (see below)
npm install
npm run dev                  # predev builds public/awsw.js first
npm test                     # Vitest suite
npm run build                # typecheck + production build into dist/
```

A missing `VITE_*` variable fails dev/build with a message naming it.

## Environment variables (`.env.local`, gitignored)

All values are public — they ship in the browser bundle.

| Variable | Where it comes from |
|---|---|
| `VITE_API_BASE_URL` | The API origin, e.g. `https://api.alerts.example.com`. Must match the `connect-src` API host in `vercel.json`. |
| `VITE_FIREBASE_API_KEY` | Firebase console → Project settings → Your apps → web app config. |
| `VITE_FIREBASE_AUTH_DOMAIN` | Same (usually `<project>.firebaseapp.com`). |
| `VITE_FIREBASE_PROJECT_ID` | Same. |
| `VITE_FIREBASE_APP_ID` | Same. |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Same. |
| `VITE_FCM_VAPID_KEY` | Firebase console → Project settings → Cloud Messaging → Web Push certificates → **Generate key pair**; copy the public key. |

The Firebase **service account never belongs in this project** — the web app
only uses the public web config.

## Firebase setup

1. Create a Firebase project and add a **web app**; copy its config into
   `.env.local`.
2. Authentication → Sign-in method → enable **Google**.
3. Authentication → Settings → **Authorized domains**: add the app domain
   (`alerts.example.com`) — `localhost` is allowed by default for dev.
4. Project settings → Cloud Messaging → **Web Push certificates** → generate a
   key pair; the public key is `VITE_FCM_VAPID_KEY`.

## Deployment (Vercel)

Deploy as its **own Vercel project** with the root directory set to `web/`.

- Build command: `npm run build` (runs `scripts/build-sw.mjs` first, which
  also validates env vars).
- Output directory: `dist`.
- Set all `VITE_*` variables in the Vercel project environment.
- `vercel.json` adds the Content-Security-Policy and security headers, marks
  the service workers `no-cache`, and rewrites SPA routes to `index.html`.
- If the API origin is not `https://api.alerts.example.com`, update
  `connect-src` in `vercel.json`.

CORS: the API allows the app origin only — cross-origin calls from other
origins are rejected by the browser anyway.

## Reliability caveats

Phones **without Google Play services** cannot receive alerts — Chrome's push
service is FCM. Devices where **Chrome is battery-restricted** may delay or
drop notifications; check Chrome's battery setting if alerts stop arriving.
On iOS, push requires adding the app to the Home Screen first.

## Manual checklist

- [ ] Sign in on Chrome for Android with the account used for the CLI. The
      dashboard shows that email.
- [ ] Turn on alerts in this browser, then turn the flag on. The switch shows
      the server's value.
- [ ] Close the tab and trigger a failed run from the CLI. A notification
      appears.
- [ ] Lock the phone for 30 minutes and trigger another failure. Record
      whether the notification arrives. If it doesn't, check Chrome's battery
      setting.
- [ ] Tap a notification. The app opens and shows the alert.
- [ ] Deny notification permission. The banner appears.
- [ ] Approve one pending computer and deny another from the approval page.
      Both show the right result.
- [ ] Revoke a computer. Its next event is rejected, and the CLI reports it.
- [ ] Sign out. Alerts stop in this browser.
- [ ] Delete the account. Data is removed, and no more alerts arrive.
- [ ] Optional: on iOS, add the app to the home screen and repeat the first
      two steps. Record the result. **Don't claim iOS support until it's
      tested.**

## Layout

- `public/firebase-messaging-sw.js` — the service worker (static; loads the
  Firebase compat SDKs and `awsw.js`).
- `src/shared/awsw.ts` — all push handling logic; bundled to `public/awsw.js`
  by `scripts/build-sw.mjs` and shared with the page and the tests.
- `src/lib/` — API client, IndexedDB helper, push registration, auth context.
- `src/components/`, `src/pages/` — dashboard sections and routes.
- `docs/security.md` — what secrets live in the browser and why the CSP is
  strict. `NOTES.md` — decisions, conflicts, unverified items.
