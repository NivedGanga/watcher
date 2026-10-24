import { Hono } from 'hono';
import type { Vars } from '../middleware/auth.js';
import { cronAuth, getConfig, getDb, getDeps } from '../middleware/auth.js';
import { runTick } from '../worker/tick.js';

export const jobRoutes = new Hono<{ Variables: Vars }>();

const tick = async (c: import('hono').Context<{ Variables: Vars }>) => {
  await runTick(getDb(c), getDeps(c), getConfig(c));
  return c.json({ ok: true });
};

// POST is the documented protocol surface. GET is accepted for Vercel Cron,
// which only issues GET requests (with the same Authorization header).
jobRoutes.post('/api/jobs/tick', cronAuth, tick);
jobRoutes.get('/api/jobs/tick', cronAuth, tick);
