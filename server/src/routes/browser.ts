import { Hono } from 'hono';
import type { Vars } from '../middleware/auth.js';
import { deviceAuth, getDb, getDeps, getPrincipal } from '../middleware/auth.js';
import { validationFailed, notFound, unauthorized } from '../lib/errors.js';
import { validateBody, isNonEmptyString } from '../lib/validate.js';
import * as repo from '../repo.js';
import { REMINDER_DELAY_MS } from '../lib/time.js';

export const browserRoutes = new Hono<{ Variables: Vars }>();

browserRoutes.post('/api/receipts', deviceAuth, async (c) => {
  const p = getPrincipal(c);
  if (p.kind !== 'device') return unauthorized(c);
  const body = await c.req.json().catch(() => null);
  const v = validateBody<{ delivery_id: string }>(body, { delivery_id: isNonEmptyString(64) });
  if (!v.ok) return validationFailed(c, v.reason);

  const db = getDb(c);
  const deps = getDeps(c);
  const now = new Date();
  const updated = await repo.ackDelivery(db, v.value.delivery_id, p.deviceId, now);
  if (!updated || updated.userId !== p.userId) return notFound(c);
  await repo.touchDeviceSeen(db, p.deviceId, now);

  // A receipt on a question schedules the 10-minute reminder. Enqueue is
  // deduplicated by job key, so repeat receipts are harmless.
  const event = await repo.getEvent(db, p.userId, updated.eventId);
  if (event && event.type === 'question') {
    const questionTs = event.eventTimestamp.getTime();
    const runAt = new Date(Math.max(now.getTime(), questionTs + REMINDER_DELAY_MS));
    await deps.jobs.enqueue(
      'question_reminder',
      { user_id: p.userId, event_id: event.id, run_id: event.runId, question_ts: event.eventTimestamp.toISOString() },
      runAt,
      { dedupeKey: `qr:${event.id}` },
    );
  }
  return c.body(null, 204);
});

browserRoutes.post('/api/devices/seen', deviceAuth, async (c) => {
  const p = getPrincipal(c);
  if (p.kind !== 'device') return unauthorized(c);
  await repo.touchDeviceSeen(getDb(c), p.deviceId, new Date());
  return c.body(null, 204);
});
