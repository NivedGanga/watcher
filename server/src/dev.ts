import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { ensureIndexes } from './db/indexes.js';
import { createApp } from './create-app.js';
import { FirebaseAuthProvider, FcmPushProvider } from './providers/firebase.js';
import { ResendEmailProvider } from './providers/resend.js';
import { MongoJobRunner, fetchHealthCheck } from './providers/jobs.js';
import { log } from './lib/logger.js';

const config = loadConfig();
const { db } = createDb(config.databaseUrl);
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

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
log.info('agentwatch api listening', { port });
