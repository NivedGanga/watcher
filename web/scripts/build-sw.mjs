// Bundles src/shared/awsw.ts into public/awsw.js as an IIFE exposing
// `AgentWatchSW`, and injects the build-time API base URL and Firebase config
// (the service worker is a static file and cannot read import.meta.env).
//
// Reads .env.local / .env (dotenv-style KEY=VALUE) plus process.env.

import { build } from 'esbuild';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(name) {
  const p = join(root, name);
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const env = { ...loadEnvFile('.env'), ...loadEnvFile('.env.local'), ...process.env };

const REQUIRED = [
  'VITE_API_BASE_URL',
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FCM_VAPID_KEY',
];
const missing = REQUIRED.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}. Set in web/.env.local.`);
  process.exit(1);
}

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
};

await build({
  entryPoints: [join(root, 'src/shared/awsw.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'AgentWatchSW',
  platform: 'browser',
  target: 'es2020',
  outfile: join(root, 'public/awsw.js'),
  banner: {
    js: `self.AGENTWATCH_API_BASE = ${JSON.stringify(env.VITE_API_BASE_URL.replace(/\/+$/, ''))};\n` +
      `firebase.initializeApp(${JSON.stringify(firebaseConfig)});`,
  },
});

console.log('wrote public/awsw.js');
