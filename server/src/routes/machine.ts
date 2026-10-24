import { Hono } from 'hono';
import type { Vars } from '../middleware/auth.js';
import { machineAuth, getConfig, getDb, getDeps, getPrincipal } from '../middleware/auth.js';
import { validationFailed, notFound, limitReached, rateLimited, unauthorized, apiError } from '../lib/errors.js';
import { validateBody, validateEvent, validateSignal, validateHeartbeat, firstError } from '../lib/validate.js';
import { route, shouldAutoOff } from '../routing/route.js';
import { applyRoutePlan } from '../worker/plan.js';
import * as repo from '../repo.js';
import { EMAIL_MONTHLY_CAP } from '../lib/time.js';

export const machineRoutes = new Hono<{ Variables: Vars }>();

const machinePrincipal = (c: import('hono').Context<{ Variables: Vars }>) => {
  const p = getPrincipal(c);
  return p.kind === 'machine' ? p : null;
};

const MAX_BODY = 64 * 1024;

async function readLimitedBody(c: import('hono').Context<{ Variables: Vars }>) {
  const text = await c.req.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY) return { error: 'body exceeds 64 KB' as const };
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    return { error: 'malformed JSON' as const };
  }
}

machineRoutes.post('/api/events', machineAuth, async (c) => {
  const p = machinePrincipal(c);
  if (!p) return unauthorized(c);
  const db = getDb(c);
  const config = getConfig(c);
  const deps = getDeps(c);
  const now = new Date();

  const retry = await repo.hitRateLimit(db, `events:${p.machineId}`, 60, 60, now);
  if (retry !== null) return rateLimited(c, retry);

  const parsed = await readLimitedBody(c);
  if ('error' in parsed) return validationFailed(c, parsed.error);
  const body = parsed.body as Record<string, unknown> | null;
  if (!body || !Array.isArray(body['events'])) return validationFailed(c);
  const rawEvents = body['events'] as unknown[];
  if (rawEvents.length < 1 || rawEvents.length > 50) {
    return validationFailed(c, 'events must contain 1-50 items');
  }

  interface Result {
    id?: string;
    status: 'accepted' | 'duplicate' | 'rejected';
    reason?: string;
  }
  const results: Result[] = [];

  // The user-row lock keeps grouping counts correct across concurrent batches.
  await db.transaction(async (tx) => {
    const t = repo.asDb(tx);
    await repo.lockUser(t, p.userId);

    for (const raw of rawEvents) {
      if (!validateEvent(raw)) {
        const r: Result = { status: 'rejected', reason: firstError(validateEvent) };
        if (raw && typeof raw === 'object' && 'id' in raw) r.id = String((raw as { id: unknown }).id);
        results.push(r);
        continue;
      }
      const e = raw as Record<string, unknown>;
      const id = String(e['id']);
      const type = String(e['type']);
      const runId = String(e['run_id']);
      const agent = String(e['agent']);
      const summary = String(e['summary']);
      const eventTs = new Date(String(e['timestamp']));

      const dupById = await repo.eventExists(t, p.userId, id);
      const dupByTuple =
        !dupById && (await repo.findDedupeMatch(t, p.userId, runId, type, summary, eventTs));
      if (dupById || dupByTuple) {
        results.push({ id, status: 'duplicate' });
        continue;
      }

      const state = await repo.loadRouteState(t, p.userId, agent, now, config.awayMaxHours);
      const plan = route(
        {
          id,
          type,
          agent,
          runId,
          host: String(e['host']),
          summary,
          emailAllowed: e['email_allowed'] === true,
          eventTimestamp: eventTs.getTime(),
        },
        state,
      );
      await repo.insertEvent(t, {
        userId: p.userId,
        id,
        machineId: p.machineId,
        agent,
        runId,
        host: String(e['host']),
        type,
        blocking: e['blocking'] === true,
        summary,
        exitCode: typeof e['exit_code'] === 'number' ? e['exit_code'] : null,
        durationS: typeof e['duration_s'] === 'number' ? e['duration_s'] : null,
        emailAllowed: e['email_allowed'] === true,
        eventTimestamp: eventTs,
        routing: plan.routing,
      });
      if (plan.group) {
        await repo.applyGroupUpdate(t, p.userId, agent, plan.group);
      }
      await applyRoutePlan(t, deps, p.userId, { id, agent }, plan);
      results.push({ id, status: 'accepted' });
    }
  });

  return c.json({ results }, 202);
});

machineRoutes.post('/api/signals', machineAuth, async (c) => {
  const p = machinePrincipal(c);
  if (!p) return unauthorized(c);
  const db = getDb(c);
  const config = getConfig(c);
  const deps = getDeps(c);
  const now = new Date();

  const parsed = await readLimitedBody(c);
  if ('error' in parsed) return validationFailed(c, parsed.error);
  const body = parsed.body as Record<string, unknown> | null;
  if (!body || !Array.isArray(body['signals'])) return validationFailed(c);
  const rawSignals = body['signals'] as unknown[];
  if (rawSignals.length < 1 || rawSignals.length > 50) {
    return validationFailed(c, 'signals must contain 1-50 items');
  }

  interface Result {
    id?: string;
    status: 'accepted' | 'duplicate' | 'rejected';
    reason?: string;
  }
  const results: Result[] = [];
  const returnIdleSeconds = config.returnIdleMinutes * 60;

  await db.transaction(async (tx) => {
    const t = repo.asDb(tx);
    const user = await repo.lockUser(t, p.userId);
    let flagOn = user?.notifyOnPhone ?? false;

    for (const raw of rawSignals) {
      if (!validateSignal(raw)) {
        const r: Result = { status: 'rejected', reason: firstError(validateSignal) };
        if (raw && typeof raw === 'object' && 'id' in raw) r.id = String((raw as { id: unknown }).id);
        results.push(r);
        continue;
      }
      const s = raw as Record<string, unknown>;
      const outcome = await repo.insertSignal(t, {
        userId: p.userId,
        id: String(s['id']),
        machineId: p.machineId,
        kind: String(s['kind']),
        runId: s['run_id'] === null || s['run_id'] === undefined ? null : String(s['run_id']),
        at: new Date(String(s['at'])),
        idleSeconds:
          s['idle_seconds'] === null || s['idle_seconds'] === undefined
            ? null
            : Number(s['idle_seconds']),
      });
      if (outcome === 'duplicate') {
        results.push({ id: String(s['id']), status: 'duplicate' });
        continue;
      }
      // Auto-off applies inside the same transaction as the flag update.
      if (
        s['kind'] === 'input_resumed' &&
        user &&
        flagOn &&
        shouldAutoOff(
          {
            notifyOnPhone: flagOn,
            phoneAlertsSince: user.phoneAlertsSince?.getTime() ?? null,
            emailVerified: user.emailVerified,
          },
          { at: new Date(String(s['at'])).getTime(), idleSeconds: Number(s['idle_seconds']) },
          returnIdleSeconds,
        )
      ) {
        await repo.setNotifyFlag(t, p.userId, false, now);
        flagOn = false;
        await deps.jobs.enqueue(
          'state_push',
          { user_id: p.userId },
          now,
          { dbOrTx: t, dedupeKey: `sp:${p.userId}:autooff:${String(s['id'])}` },
        );
      }
      results.push({ id: String(s['id']), status: 'accepted' });
    }
  });

  return c.json({ results }, 202);
});

machineRoutes.post('/api/heartbeat', machineAuth, async (c) => {
  const p = machinePrincipal(c);
  if (!p) return unauthorized(c);
  const parsed = await readLimitedBody(c);
  if ('error' in parsed) return validationFailed(c, parsed.error);
  if (!validateHeartbeat(parsed.body)) {
    return validationFailed(c, firstError(validateHeartbeat));
  }
  const body = parsed.body as { active_runs: number };
  // A heartbeat ends any open silence episode (clears silent_alerted_at).
  await repo.recordHeartbeat(getDb(c), p.machineId, body.active_runs, new Date());
  return c.body(null, 204);
});

machineRoutes.post('/api/machines/current/test', machineAuth, async (c) => {
  const p = machinePrincipal(c);
  if (!p) return unauthorized(c);
  const db = getDb(c);
  const deps = getDeps(c);
  const now = new Date();

  const retry = await repo.hitRateLimit(db, `test:${p.machineId}`, 3600, 5, now);
  if (retry !== null) return rateLimited(c, retry);

  const user = await repo.getUser(db, p.userId);
  if (!user) return notFound(c);
  if (!user.emailVerified) return apiError(c, 403, 'email_not_verified', 'Account email is not verified');
  if ((await repo.emailsSentThisMonth(db, p.userId, now)) >= EMAIL_MONTHLY_CAP) {
    return limitReached(c);
  }
  const machine = await repo.getMachine(db, p.machineId);
  await deps.jobs.enqueue(
    'test_email',
    { user_id: p.userId, machine_name: machine?.name ?? p.machineId },
    now,
    { dedupeKey: `test:${p.machineId}:${now.getTime()}` },
  );
  return c.json({ sent: true }, 202);
});

machineRoutes.delete('/api/machines/current', machineAuth, async (c) => {
  const p = machinePrincipal(c);
  if (!p) return unauthorized(c);
  const ok = await repo.revokeMachine(getDb(c), p.userId, p.machineId, new Date());
  if (!ok) return notFound(c);
  return c.body(null, 204);
});
