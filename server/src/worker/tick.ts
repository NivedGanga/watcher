import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { Deps } from '../providers/types.js';
import * as repo from '../repo.js';
import { route, closingSummary, tableRouteForClose } from '../routing/route.js';
import { applyRoutePlan } from './plan.js';
import { executeDelivery, sendStatePushes, buildEmail } from './notify.js';
import { log } from '../lib/logger.js';
import { rfc3339 } from '../lib/time.js';

const JOB_BATCH = 100;
const DELIVERY_BATCH = 50;
const TICK_BUDGET_MS = 50_000;
const SILENCE_MS = 15 * 60_000;
const RETENTION_INTERVAL_MS = 24 * 3_600_000;

/**
 * One scheduler tick (~1/min). Claims due jobs, runs the silence detector and
 * hard cap, drains pending deliveries, applies retention once a day, then
 * pings the healthcheck. Safe to run concurrently — claiming is atomic.
 */
export async function runTick(
  db: repo.Q,
  deps: Deps,
  config: Config,
  now = new Date(),
): Promise<{ ok: true }> {
  const deadline = now.getTime() + TICK_BUDGET_MS;

  // 1. Due jobs.
  const jobs = await repo.claimDueJobs(db, now, JOB_BATCH);
  for (const job of jobs) {
    if (Date.now() > deadline) break;
    try {
      await runJob(db, deps, config, job, now);
      await repo.finishJob(db, job.id, 'done');
    } catch (err) {
      log.warn('job failed', { jobId: job.id, kind: job.kind });
      if (job.attempts + 1 >= 5) {
        await repo.finishJob(db, job.id, 'failed');
      } else {
        const backoff = Math.min(30_000 * 2 ** job.attempts, 600_000);
        await repo.finishJob(db, job.id, 'pending', new Date(now.getTime() + backoff));
      }
    }
  }

  // 2. Silent-machine check.
  for (const m of await repo.silentMachines(db, now, SILENCE_MS)) {
    await repo.markSilentAlerted(db, m.id, now);
    if (m.activeRuns > 0) {
      await createHostSilentEvent(db, deps, config, m, now);
    }
  }

  // 3. Hard cap.
  const expiredUsers = await repo.hardCapSweep(db, now, config.awayMaxHours * 3_600_000);
  for (const userId of expiredUsers) {
    await sendStatePushes(db, deps, config, userId, now);
  }

  // 4. Drain due deliveries. Deliveries created mid-tick (e.g. by the
  // silence check or by jobs above) have next_attempt_at marginally after
  // the tick's `now`, so drain against the later of the two clocks.
  const drainNow = new Date(Math.max(now.getTime(), Date.now()));
  while (Date.now() < deadline) {
    const due = await repo.dueDeliveries(db, drainNow, DELIVERY_BATCH);
    if (due.length === 0) break;
    for (const d of due) {
      if (Date.now() > deadline) return finish(db, deps, config, now);
      const claimed = await repo.claimDelivery(db, d.id, drainNow);
      if (!claimed) continue;
      await executeDelivery(db, claimed, deps, config, now);
    }
    if (due.length < DELIVERY_BATCH) break;
  }

  return finish(db, deps, config, now);
}

async function finish(db: repo.Q, deps: Deps, config: Config, now: Date): Promise<{ ok: true }> {
  // 5. Retention, at most once per 24h.
  const last = await repo.getSystemState(db, 'retention_last_run');
  if (!last || now.getTime() - new Date(last).getTime() > RETENTION_INTERVAL_MS) {
    await repo.deleteOldEvents(db, new Date(now.getTime() - 30 * 24 * 3_600_000));
    await repo.deleteOldSignals(db, new Date(now.getTime() - 7 * 24 * 3_600_000));
    await repo.deleteExpiredAuthorizations(db, now);
    await repo.setSystemState(db, 'retention_last_run', now.toISOString());
  }
  // 6. Healthcheck ping.
  try {
    await deps.healthcheck.ping(config.healthcheckUrl);
  } catch {
    log.warn('healthcheck ping failed');
  }
  return { ok: true };
}

async function runJob(db: repo.Q, deps: Deps, config: Config, job: repo.JobRow, now: Date): Promise<void> {
  const p = job.payload;
  switch (job.kind) {
    case 'email_fallback': {
      const userId = String(p['user_id']);
      const eventId = String(p['event_id']);
      if (await repo.hasEmailDelivery(db, eventId)) return; // idempotent
      const acked = await repo.eventHasAckedPush(db, userId, eventId);
      await repo.insertDelivery(db, {
        userId, eventId, channel: 'email', deviceId: null,
        payload: { kind: 'fallback' },
        ...(acked ? { status: 'skipped', skipReason: 'receipt' } : {}),
      });
      return;
    }
    case 'question_reminder': {
      const userId = String(p['user_id']);
      const eventId = String(p['event_id']);
      const runId = String(p['run_id']);
      const questionTs = new Date(String(p['question_ts']));
      const cancelled = await repo.hasOutputSeen(db, userId, runId, questionTs);
      const existing = await repo.getEmailDelivery(db, eventId);
      if (existing) {
        // A skipped placeholder (e.g. receipt-suppressed fallback) is
        // repurposed for the reminder — the event still gets exactly one
        // email delivery. Anything already sent/failed is left alone.
        if (existing.status !== 'skipped') return;
        await repo.markDelivery(db, existing.id, cancelled
          ? { status: 'skipped', skipReason: 'output_seen', payload: { kind: 'reminder' } }
          : { status: 'pending', skipReason: null, nextAttemptAt: now, payload: { kind: 'reminder' } });
        return;
      }
      const id = await repo.insertDelivery(db, {
        userId, eventId, channel: 'email', deviceId: null,
        payload: { kind: 'reminder' },
      });
      if (cancelled) {
        await repo.markDelivery(db, id, { status: 'skipped', skipReason: 'output_seen' });
      }
      return;
    }
    case 'group_close': {
      await closeGroupWindow(db, deps, config, p, now);
      return;
    }
    case 'state_push': {
      await sendStatePushes(db, deps, config, String(p['user_id']), now);
      return;
    }
    case 'test_email': {
      await sendSimpleEmail(db, deps, config, String(p['user_id']), now, (user) => ({
        subject: `[agentwatch] test email`,
        text: `This is a test alert from AgentWatch for machine ${String(p['machine_name'])}.\n\nManage alerts: ${config.appUrl}`,
      }));
      return;
    }
    case 'machine_connected_email': {
      await sendSimpleEmail(db, deps, config, String(p['user_id']), now, () => ({
        subject: `[agentwatch] New computer connected`,
        text: `A new computer was connected to your AgentWatch account.\n\nname: ${String(p['client_name'])}\nos: ${String(p['client_os'])}\n\nManage computers: ${config.appUrl}/computers`,
      }));
      return;
    }
    default:
      log.warn('unknown job kind', { kind: job.kind });
  }
}

/** Send a non-event email (test, machine connected) with verified + cap checks. */
async function sendSimpleEmail(
  db: repo.Q,
  deps: Deps,
  config: Config,
  userId: string,
  now: Date,
  build: (user: repo.UserRow) => { subject: string; text: string },
): Promise<void> {
  const user = await repo.getUser(db, userId);
  if (!user || !user.emailVerified || user.deletedAt) return;
  const sent = await repo.emailsSentThisMonth(db, userId, now);
  if (sent >= 200) return;
  const msg = build(user);
  await deps.email.send({ from: config.emailFrom, to: user.email, ...msg });
  await repo.incrementEmailsSent(db, userId, now);
}

async function closeGroupWindow(
  db: repo.Q,
  deps: Deps,
  config: Config,
  payload: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const userId = String(payload['user_id']);
  const agent = String(payload['agent']);
  const windowStart = new Date(String(payload['window_start']));
  const group = await repo.getGroup(db, userId, agent, windowStart);
  if (!group || group.closedAt) return; // idempotent
  await repo.closeGroup(db, userId, agent, windowStart, now);
  if (group.suppressed <= 0) return;
  if (!group.latestEventId || !group.triggerEventId) return;

  const [trigger, latest] = await Promise.all([
    repo.getEvent(db, userId, group.triggerEventId),
    repo.getEvent(db, userId, group.latestEventId),
  ]);
  if (!trigger || !latest) return;

  const summary = closingSummary(group.count, agent, group.suppressed);
  // Route the closing message like the grouped message: through the table
  // using the triggering event's type, urgency normal.
  const plan = tableRouteForClose(
    {
      ...latest,
      eventTimestamp: latest.eventTimestamp.getTime(),
      emailAllowed: trigger.emailAllowed,
    },
    await repo.loadRouteState(db, userId, agent, now, config.awayMaxHours),
    trigger.type,
    'group_closed',
    summary,
  );
  await applyRoutePlan(db, deps, userId, { id: latest.id, agent }, plan);
}

async function createHostSilentEvent(
  db: repo.Q,
  deps: Deps,
  config: Config,
  machine: repo.MachineRow,
  now: Date,
): Promise<void> {
  const runId = (await repo.latestRunId(db, machine.userId, machine.id)) ?? 'none';
  const id = randomUUID();
  const summary = `${machine.name} has stopped reporting.`;
  const state = await repo.loadRouteState(db, machine.userId, 'agentwatch', now, config.awayMaxHours);
  const event = {
    id,
    type: 'host_silent',
    agent: 'agentwatch',
    runId,
    host: machine.name,
    summary,
    emailAllowed: true,
    eventTimestamp: now.getTime(),
  };
  const plan = route(event, state);
  await repo.insertEvent(db, {
    userId: machine.userId,
    id,
    machineId: machine.id,
    agent: 'agentwatch',
    runId,
    host: machine.name,
    type: 'host_silent',
    blocking: true,
    summary,
    exitCode: null,
    durationS: null,
    emailAllowed: true,
    eventTimestamp: now,
    routing: plan.routing,
  });
  await applyRoutePlan(db, deps, machine.userId, { id, agent: 'agentwatch' }, plan);
  log.info('host_silent event created', { machineId: machine.id });
}
