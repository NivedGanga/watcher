import 'hono';
import { loadConfig } from './src/config.js';
import { createDb } from './src/db/client.js';
import { ensureIndexes } from './src/db/indexes.js';
import { createApp } from './src/create-app.js';
import { FirebaseAuthProvider, FcmPushProvider } from './src/providers/firebase.js';
import { ResendEmailProvider } from './src/providers/resend.js';
import { MongoJobRunner, fetchHealthCheck } from './src/providers/jobs.js';

// Vercel detects the Hono framework from this entry file and wraps
// `app.fetch` as a Function (see NOTES.md).
const config = loadConfig();
const { db } = createDb(config.databaseUrl);
// Idempotent — ensures collections/indexes exist before traffic.
await ensureIndexes(db.db);

const app = createApp({
  config,
  db,
  deps: {
    auth: new FirebaseAuthProvider(config.firebaseProjectId, config.firebaseServiceAccountJsonB64),
    push: new FcmPushProvider(config.firebaseProjectId, config.firebaseServiceAccountJsonB64),
    email: new ResendEmailProvider(config.resendApiKey),
    jobs: new MongoJobRunner(db),
    healthcheck: fetchHealthCheck,
  },
});

export default app;
