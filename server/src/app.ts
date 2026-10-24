import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Config } from './config.js';
import type { Deps } from './providers/types.js';
import type { Db } from './db/client.js';
import type { Vars } from './middleware/auth.js';
import { protocol } from './middleware/auth.js';
import { errorBody } from './lib/errors.js';
import { log } from './lib/logger.js';
import { meRoutes } from './routes/me.js';
import { enrollRoutes } from './routes/enroll.js';
import { machineRoutes } from './routes/machine.js';
import { browserRoutes } from './routes/browser.js';
import { jobRoutes } from './routes/jobs.js';

export interface AppOptions {
  config: Config;
  deps: Deps;
  db: Db;
}

export function createApp(opts: AppOptions) {
  const { config, deps, db } = opts;
  const app = new Hono<{ Variables: Vars }>();

  app.use(
    '*',
    cors({
      origin: config.corsOrigin,
      allowHeaders: ['Authorization', 'Content-Type', 'X-AgentWatch-Protocol'],
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    }),
  );

  app.use('*', async (c, next) => {
    c.set('config', config);
    c.set('deps', deps);
    c.set('db', db);
    await next();
  });

  app.use('/api/*', protocol);

  app.route('/', meRoutes);
  app.route('/', enrollRoutes);
  app.route('/', machineRoutes);
  app.route('/', browserRoutes);
  app.route('/', jobRoutes);

  app.notFound((c) => c.json(errorBody('not_found', 'Resource does not exist'), 404));

  app.onError((err, c) => {
    log.error('unhandled error', { path: c.req.path, message: err.message });
    return c.json(errorBody('internal', 'Internal error'), 500);
  });

  return app;
}
