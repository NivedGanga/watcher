import { and, desc, eq, gt, lt, isNull, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { Db } from './db/client.js';
import * as t from './db/schema.js';
import { monthKey, DEVICE_ACTIVE_WINDOW_MS } from './lib/time.js';
import type { RouteGroup } from './routing/route.js';

/** Repo functions accept a transaction too; drizzle tx objects satisfy the Db API surface used here. */
export type Q = Db;
export const asDb = (tx: unknown): Q => tx as Q;

// ---------- users ----------

export interface UserRow {
  id: string;
  firebaseUid: string;
  email: string;
  emailVerified: boolean;
  notifyOnPhone: boolean;
  phoneAlertsSince: Date | null;
  deletedAt: Date | null;
}

export async function upsertUserFromToken(
  db: Q,
  input: { firebaseUid: string; email: string; emailVerified: boolean },
): Promise<UserRow> {
  const rows = await db
    .insert(t.users)
    .values(input)
    .onConflictDoUpdate({
      target: t.users.firebaseUid,
      set: { email: input.email, emailVerified: input.emailVerified },
    })
    .returning();
  return rows[0] as UserRow;
}

export async function getUser(db: Q, userId: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(t.users).where(eq(t.users.id, userId)).limit(1);
  return rows[0] as UserRow | undefined;
}

export async function lockUser(db: Q, userId: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(t.users).where(eq(t.users.id, userId)).for('update').limit(1);
  return rows[0] as UserRow | undefined;
}

export async function setNotifyFlag(db: Q, userId: string, enabled: boolean, now: Date): Promise<void> {
  await db
    .update(t.users)
    .set(
      enabled
        ? { notifyOnPhone: true, phoneAlertsSince: now }
        : { notifyOnPhone: false },
    )
    .where(eq(t.users.id, userId));
}

/** Hard-cap sweep: turn off flags past the deadline. Returns affected user ids. */
export async function hardCapSweep(db: Q, now: Date, awayMaxMs: number): Promise<string[]> {
  const rows = await db.execute(
    sql`UPDATE users SET notify_on_phone = false
        WHERE notify_on_phone = true
          AND phone_alerts_since IS NOT NULL
          AND phone_alerts_since + ${awayMaxMs} * interval '1 millisecond' <= ${now.toISOString()}
          AND deleted_at IS NULL
        RETURNING id`,
  );
  return (rows as unknown as { id: string }[]).map((r) => r.id);
}

export async function deleteAccount(db: Q, userId: string): Promise<void> {
  const now = new Date();
  await db.delete(t.deliveries).where(eq(t.deliveries.userId, userId));
  await db.delete(t.events).where(eq(t.events.userId, userId));
  await db.delete(t.signals).where(eq(t.signals.userId, userId));
  await db.delete(t.groups).where(eq(t.groups.userId, userId));
  await db.delete(t.usageMonthly).where(eq(t.usageMonthly.userId, userId));
  await db.execute(
    sql`DELETE FROM jobs WHERE status = 'pending' AND payload->>'user_id' = ${userId}`,
  );
  await db.execute(
    sql`DELETE FROM rate_limits WHERE key LIKE ${'u:' + userId + ':%'}`,
  );
  await db
    .update(t.deviceAuthorizations)
    .set({ status: 'expired' })
    .where(and(eq(t.deviceAuthorizations.userId, userId), eq(t.deviceAuthorizations.status, 'pending')));
  await db
    .update(t.devices)
    .set({ revokedAt: now })
    .where(and(eq(t.devices.userId, userId), isNull(t.devices.revokedAt)));
  await db
    .update(t.machines)
    .set({ revokedAt: now })
    .where(and(eq(t.machines.userId, userId), isNull(t.machines.revokedAt)));
  await db.update(t.users).set({ deletedAt: now }).where(eq(t.users.id, userId));
}

// ---------- devices ----------

export interface DeviceRow {
  id: string;
  userId: string;
  fcmTokenEnc: string;
  fcmTokenHash: string;
  deviceSecretHash: string;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

export async function getDevice(db: Q, deviceId: string): Promise<DeviceRow | undefined> {
  const rows = await db.select().from(t.devices).where(eq(t.devices.id, deviceId)).limit(1);
  return rows[0] as DeviceRow | undefined;
}

export async function findDeviceByTokenHash(db: Q, userId: string, hash: string): Promise<DeviceRow | undefined> {
  const rows = await db
    .select()
    .from(t.devices)
    .where(and(eq(t.devices.userId, userId), eq(t.devices.fcmTokenHash, hash)))
    .limit(1);
  return rows[0] as DeviceRow | undefined;
}

export async function countLiveDevices(db: Q, userId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(t.devices)
    .where(and(eq(t.devices.userId, userId), isNull(t.devices.revokedAt)));
  return rows[0]!.n;
}

export async function insertDevice(
  db: Q,
  row: { id: string; userId: string; fcmTokenEnc: string; fcmTokenHash: string; deviceSecretHash: string },
): Promise<void> {
  await db.insert(t.devices).values(row);
}

export async function rotateDeviceSecret(
  db: Q,
  deviceId: string,
  deviceSecretHash: string,
  now: Date,
): Promise<void> {
  await db
    .update(t.devices)
    .set({ deviceSecretHash, lastSeenAt: now, revokedAt: null })
    .where(eq(t.devices.id, deviceId));
}

export async function revokeDevice(db: Q, userId: string, deviceId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(t.devices)
    .set({ revokedAt: now })
    .where(and(eq(t.devices.id, deviceId), eq(t.devices.userId, userId), isNull(t.devices.revokedAt)))
    .returning({ id: t.devices.id });
  return rows.length > 0;
}

export async function revokeDeviceById(db: Q, deviceId: string, now: Date): Promise<void> {
  await db.update(t.devices).set({ revokedAt: now }).where(eq(t.devices.id, deviceId));
}

export async function touchDeviceSeen(db: Q, deviceId: string, now: Date): Promise<void> {
  await db.update(t.devices).set({ lastSeenAt: now }).where(eq(t.devices.id, deviceId));
}

/** Devices eligible for pushes: not revoked AND last seen strictly within 14 days. */
export async function listActiveDevices(db: Q, userId: string, now: Date): Promise<DeviceRow[]> {
  const cutoff = new Date(now.getTime() - DEVICE_ACTIVE_WINDOW_MS);
  const rows = await db
    .select()
    .from(t.devices)
    .where(
      and(
        eq(t.devices.userId, userId),
        isNull(t.devices.revokedAt),
        gt(t.devices.lastSeenAt, cutoff),
      ),
    );
  return rows as DeviceRow[];
}

// ---------- machines ----------

export interface MachineRow {
  id: string;
  userId: string;
  name: string;
  os: string;
  keyHash: string;
  lastHeartbeatAt: Date | null;
  activeRuns: number;
  silentAlertedAt: Date | null;
  revokedAt: Date | null;
}

export async function getMachine(db: Q, machineId: string): Promise<MachineRow | undefined> {
  const rows = await db.select().from(t.machines).where(eq(t.machines.id, machineId)).limit(1);
  return rows[0] as MachineRow | undefined;
}

export async function countLiveMachines(db: Q, userId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(t.machines)
    .where(and(eq(t.machines.userId, userId), isNull(t.machines.revokedAt)));
  return rows[0]!.n;
}

export async function insertMachine(
  db: Q,
  row: { id: string; userId: string; name: string; os: string; keyHash: string },
): Promise<void> {
  await db.insert(t.machines).values(row);
}

export async function listMachines(db: Q, userId: string): Promise<MachineRow[]> {
  const rows = await db
    .select()
    .from(t.machines)
    .where(and(eq(t.machines.userId, userId), isNull(t.machines.revokedAt)))
    .orderBy(t.machines.createdAt);
  return rows as MachineRow[];
}

export async function revokeMachine(db: Q, userId: string, machineId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(t.machines)
    .set({ revokedAt: now })
    .where(and(eq(t.machines.id, machineId), eq(t.machines.userId, userId), isNull(t.machines.revokedAt)))
    .returning({ id: t.machines.id });
  return rows.length > 0;
}

export async function recordHeartbeat(
  db: Q,
  machineId: string,
  activeRuns: number,
  now: Date,
): Promise<void> {
  await db
    .update(t.machines)
    .set({ lastHeartbeatAt: now, activeRuns, silentAlertedAt: null })
    .where(eq(t.machines.id, machineId));
}

/** Machines silent at `now` that haven't been marked yet. */
export async function silentMachines(db: Q, now: Date, thresholdMs: number): Promise<MachineRow[]> {
  const cutoff = new Date(now.getTime() - thresholdMs);
  const rows = await db
    .select()
    .from(t.machines)
    .where(
      and(
        isNull(t.machines.revokedAt),
        isNull(t.machines.silentAlertedAt),
        isNotNull(t.machines.lastHeartbeatAt),
        lt(t.machines.lastHeartbeatAt, cutoff),
      ),
    );
  return rows as MachineRow[];
}

export async function markSilentAlerted(db: Q, machineId: string, now: Date): Promise<void> {
  await db.update(t.machines).set({ silentAlertedAt: now }).where(eq(t.machines.id, machineId));
}

/** Most recent run_id reported by a machine, or null. */
export async function latestRunId(db: Q, userId: string, machineId: string): Promise<string | null> {
  const rows = await db
    .select({ runId: t.events.runId })
    .from(t.events)
    .where(and(eq(t.events.userId, userId), eq(t.events.machineId, machineId)))
    .orderBy(desc(t.events.eventTimestamp))
    .limit(1);
  return rows[0]?.runId ?? null;
}

// ---------- device authorizations ----------

export interface AuthorizationRow {
  id: string;
  deviceCodeHash: string;
  userCodeHash: string;
  clientName: string;
  clientOs: string;
  status: string;
  userId: string | null;
  createdAt: Date;
  expiresAt: Date;
  intervalSeconds: number;
  lastPolledAt: Date | null;
}

export async function insertAuthorization(
  db: Q,
  row: {
    deviceCodeHash: string;
    userCodeHash: string;
    clientName: string;
    clientOs: string;
    expiresAt: Date;
    intervalSeconds: number;
    sourceIpHash: string | null;
  },
): Promise<void> {
  await db.insert(t.deviceAuthorizations).values({ ...row, status: 'pending' });
}

export async function findAuthByDeviceCode(db: Q, deviceCodeHash: string): Promise<AuthorizationRow | undefined> {
  const rows = await db
    .select()
    .from(t.deviceAuthorizations)
    .where(eq(t.deviceAuthorizations.deviceCodeHash, deviceCodeHash))
    .limit(1);
  return rows[0] as AuthorizationRow | undefined;
}

export async function findAuthByUserCode(db: Q, userCodeHash: string): Promise<AuthorizationRow | undefined> {
  const rows = await db
    .select()
    .from(t.deviceAuthorizations)
    .where(eq(t.deviceAuthorizations.userCodeHash, userCodeHash))
    .limit(1);
  return rows[0] as AuthorizationRow | undefined;
}

export async function lockAuthByUserCode(db: Q, userCodeHash: string): Promise<AuthorizationRow | undefined> {
  const rows = await db
    .select()
    .from(t.deviceAuthorizations)
    .where(eq(t.deviceAuthorizations.userCodeHash, userCodeHash))
    .for('update')
    .limit(1);
  return rows[0] as AuthorizationRow | undefined;
}

export async function lockAuthByDeviceCode(db: Q, deviceCodeHash: string): Promise<AuthorizationRow | undefined> {
  const rows = await db
    .select()
    .from(t.deviceAuthorizations)
    .where(eq(t.deviceAuthorizations.deviceCodeHash, deviceCodeHash))
    .for('update')
    .limit(1);
  return rows[0] as AuthorizationRow | undefined;
}

export async function updateAuthorization(
  db: Q,
  id: string,
  set: Partial<{
    status: string;
    userId: string | null;
    intervalSeconds: number;
    lastPolledAt: Date;
  }>,
): Promise<void> {
  await db.update(t.deviceAuthorizations).set(set).where(eq(t.deviceAuthorizations.id, id));
}

export async function deleteExpiredAuthorizations(db: Q, now: Date): Promise<void> {
  await db.delete(t.deviceAuthorizations).where(lt(t.deviceAuthorizations.expiresAt, now));
}

// ---------- events ----------

export interface EventRow {
  userId: string;
  id: string;
  machineId: string;
  agent: string;
  runId: string;
  host: string;
  type: string;
  blocking: boolean;
  summary: string;
  exitCode: number | null;
  durationS: number | null;
  emailAllowed: boolean;
  eventTimestamp: Date;
  routing: string;
}

export async function eventExists(db: Q, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: t.events.id })
    .from(t.events)
    .where(and(eq(t.events.userId, userId), eq(t.events.id, id)))
    .limit(1);
  return rows.length > 0;
}

/** Tuple dedupe: same user + run_id + type + summary within +/- 10 minutes of the new event timestamp. */
export async function findDedupeMatch(
  db: Q,
  userId: string,
  runId: string,
  type: string,
  summary: string,
  eventTimestamp: Date,
): Promise<boolean> {
  const lo = new Date(eventTimestamp.getTime() - 600_000);
  const hi = new Date(eventTimestamp.getTime() + 600_000);
  const rows = await db
    .select({ id: t.events.id })
    .from(t.events)
    .where(
      and(
        eq(t.events.userId, userId),
        eq(t.events.runId, runId),
        eq(t.events.type, type),
        eq(t.events.summary, summary),
        gt(t.events.eventTimestamp, lo),
        lt(t.events.eventTimestamp, hi),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function insertEvent(
  db: Q,
  row: {
    userId: string;
    id: string;
    machineId: string;
    agent: string;
    runId: string;
    host: string;
    type: string;
    blocking: boolean;
    summary: string;
    exitCode: number | null;
    durationS: number | null;
    emailAllowed: boolean;
    eventTimestamp: Date;
    routing: string;
  },
): Promise<void> {
  await db.insert(t.events).values(row);
}

export async function getEvent(db: Q, userId: string, id: string): Promise<EventRow | undefined> {
  const rows = await db
    .select()
    .from(t.events)
    .where(and(eq(t.events.userId, userId), eq(t.events.id, id)))
    .limit(1);
  return rows[0] as EventRow | undefined;
}

export async function deleteOldEvents(db: Q, cutoff: Date): Promise<void> {
  await db.delete(t.deliveries).where(
    sql`event_id IN (SELECT id FROM events WHERE events.user_id = deliveries.user_id AND events.received_at < ${cutoff.toISOString()})`,
  );
  await db.delete(t.events).where(lt(t.events.receivedAt, cutoff));
}

// ---------- signals ----------

export async function insertSignal(
  db: Q,
  row: {
    userId: string;
    id: string;
    machineId: string;
    kind: string;
    runId: string | null;
    at: Date;
    idleSeconds: number | null;
  },
): Promise<'inserted' | 'duplicate'> {
  const res = await db.execute(
    sql`INSERT INTO signals (user_id, id, machine_id, kind, run_id, at, idle_seconds)
        VALUES (${row.userId}, ${row.id}, ${row.machineId}, ${row.kind}, ${row.runId}, ${row.at.toISOString()}, ${row.idleSeconds})
        ON CONFLICT (user_id, id) DO NOTHING`,
  );
  // postgres-js returns affected row count on the result object
  const count = (res as unknown as { count?: number }).count;
  return count === 0 ? 'duplicate' : 'inserted';
}

export async function hasOutputSeen(db: Q, userId: string, runId: string, atOrAfter: Date): Promise<boolean> {
  const rows = await db
    .select({ id: t.signals.id })
    .from(t.signals)
    .where(
      and(
        eq(t.signals.userId, userId),
        eq(t.signals.kind, 'output_seen'),
        eq(t.signals.runId, runId),
        sql`${t.signals.at} >= ${atOrAfter.toISOString()}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function deleteOldSignals(db: Q, cutoff: Date): Promise<void> {
  await db.delete(t.signals).where(lt(t.signals.receivedAt, cutoff));
}

// ---------- deliveries ----------

export interface DeliveryRow {
  id: string;
  userId: string;
  eventId: string;
  channel: string;
  deviceId: string | null;
  status: string;
  skipReason: string | null;
  payload: Record<string, unknown> | null;
  attempts: number;
  nextAttemptAt: Date;
  sentAt: Date | null;
  ackedAt: Date | null;
}

export async function insertDelivery(
  db: Q,
  row: {
    userId: string;
    eventId: string;
    channel: 'push' | 'email';
    deviceId: string | null;
    payload?: Record<string, unknown>;
    nextAttemptAt?: Date;
    status?: string;
    skipReason?: string;
  },
): Promise<string> {
  const rows = await db
    .insert(t.deliveries)
    .values({
      userId: row.userId,
      eventId: row.eventId,
      channel: row.channel,
      deviceId: row.deviceId,
      status: row.status ?? 'pending',
      ...(row.skipReason ? { skipReason: row.skipReason } : {}),
      ...(row.payload ? { payload: row.payload } : {}),
      ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: t.deliveries.id });
  if (rows.length > 0) return rows[0]!.id;
  // already exists (idempotent retry): return existing id
  const existing = await db
    .select({ id: t.deliveries.id })
    .from(t.deliveries)
    .where(
      and(
        eq(t.deliveries.eventId, row.eventId),
        eq(t.deliveries.channel, row.channel),
        row.deviceId === null
          ? isNull(t.deliveries.deviceId)
          : eq(t.deliveries.deviceId, row.deviceId),
      ),
    )
    .limit(1);
  return existing[0]!.id;
}

export async function getDelivery(db: Q, id: string): Promise<DeliveryRow | undefined> {
  const rows = await db.select().from(t.deliveries).where(eq(t.deliveries.id, id)).limit(1);
  return rows[0] as DeliveryRow | undefined;
}

export async function dueDeliveries(db: Q, now: Date, limit: number): Promise<DeliveryRow[]> {
  const rows = await db
    .select()
    .from(t.deliveries)
    .where(and(eq(t.deliveries.status, 'pending'), sql`${t.deliveries.nextAttemptAt} <= ${now.toISOString()}`))
    .orderBy(t.deliveries.nextAttemptAt)
    .limit(limit);
  return rows as DeliveryRow[];
}

/**
 * Claim a pending delivery by bumping attempts and pushing next_attempt_at
 * forward. Returns the claimed row, or undefined if another worker took it.
 */
export async function claimDelivery(db: Q, id: string, now: Date): Promise<DeliveryRow | undefined> {
  const rows = await db
    .update(t.deliveries)
    .set({ attempts: sql`attempts + 1`, nextAttemptAt: new Date(now.getTime() + 600_000) })
    .where(
      and(
        eq(t.deliveries.id, id),
        eq(t.deliveries.status, 'pending'),
        sql`${t.deliveries.nextAttemptAt} <= ${now.toISOString()}`,
      ),
    )
    .returning();
  return rows[0] as DeliveryRow | undefined;
}

export async function markDelivery(
  db: Q,
  id: string,
  set: Partial<{
    status: string;
    skipReason: string | null;
    payload: Record<string, unknown>;
    attempts: number;
    nextAttemptAt: Date;
    sentAt: Date;
    ackedAt: Date;
  }>,
): Promise<void> {
  await db.update(t.deliveries).set(set).where(eq(t.deliveries.id, id));
}

export async function ackDelivery(
  db: Q,
  deliveryId: string,
  deviceId: string,
  now: Date,
): Promise<DeliveryRow | undefined> {
  const rows = await db
    .update(t.deliveries)
    .set({ status: 'acked', ackedAt: now })
    .where(
      and(
        eq(t.deliveries.id, deliveryId),
        eq(t.deliveries.deviceId, deviceId),
        eq(t.deliveries.channel, 'push'),
      ),
    )
    .returning();
  return rows[0] as DeliveryRow | undefined;
}

export async function eventHasAckedPush(db: Q, userId: string, eventId: string): Promise<boolean> {
  const rows = await db
    .select({ id: t.deliveries.id })
    .from(t.deliveries)
    .where(
      and(
        eq(t.deliveries.userId, userId),
        eq(t.deliveries.eventId, eventId),
        eq(t.deliveries.channel, 'push'),
        eq(t.deliveries.status, 'acked'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function getEmailDelivery(db: Q, eventId: string): Promise<DeliveryRow | undefined> {
  const rows = await db
    .select()
    .from(t.deliveries)
    .where(and(eq(t.deliveries.eventId, eventId), eq(t.deliveries.channel, 'email')))
    .limit(1);
  return rows[0] as DeliveryRow | undefined;
}

export async function hasEmailDelivery(db: Q, eventId: string): Promise<boolean> {
  const rows = await db
    .select({ id: t.deliveries.id })
    .from(t.deliveries)
    .where(and(eq(t.deliveries.eventId, eventId), eq(t.deliveries.channel, 'email')))
    .limit(1);
  return rows.length > 0;
}

// ---------- groups ----------

export interface GroupRow {
  userId: string;
  agent: string;
  windowStart: Date;
  count: number;
  suppressed: number;
  latestEventId: string | null;
  latestSummary: string | null;
  triggerEventId: string | null;
  closedAt: Date | null;
}

export async function getOpenGroup(db: Q, userId: string, agent: string): Promise<GroupRow | undefined> {
  const rows = await db
    .select()
    .from(t.groups)
    .where(and(eq(t.groups.userId, userId), eq(t.groups.agent, agent), isNull(t.groups.closedAt)))
    .orderBy(desc(t.groups.windowStart))
    .limit(1);
  return rows[0] as GroupRow | undefined;
}

export async function getGroup(db: Q, userId: string, agent: string, windowStart: Date): Promise<GroupRow | undefined> {
  const rows = await db
    .select()
    .from(t.groups)
    .where(
      and(
        eq(t.groups.userId, userId),
        eq(t.groups.agent, agent),
        eq(t.groups.windowStart, windowStart),
      ),
    )
    .limit(1);
  return rows[0] as GroupRow | undefined;
}

export async function applyGroupUpdate(
  db: Q,
  userId: string,
  agent: string,
  u: {
    action: 'create' | 'count' | 'suppress';
    windowStart: number;
    count: number;
    suppressed: number;
    latestEventId: string;
    latestSummary: string;
    triggerEventId?: string;
  },
): Promise<void> {
  const windowStart = new Date(u.windowStart);
  if (u.action === 'create') {
    await db
      .insert(t.groups)
      .values({
        userId,
        agent,
        windowStart,
        count: u.count,
        suppressed: u.suppressed,
        latestEventId: u.latestEventId,
        latestSummary: u.latestSummary,
      })
      .onConflictDoUpdate({
        target: [t.groups.userId, t.groups.agent, t.groups.windowStart],
        set: {
          count: u.count,
          suppressed: u.suppressed,
          latestEventId: u.latestEventId,
          latestSummary: u.latestSummary,
          closedAt: null,
        },
      });
    return;
  }
  const set: Record<string, unknown> = {
    count: u.count,
    suppressed: u.suppressed,
    latestEventId: u.latestEventId,
    latestSummary: u.latestSummary,
  };
  if (u.triggerEventId) set['triggerEventId'] = u.triggerEventId;
  await db
    .update(t.groups)
    .set(set)
    .where(
      and(
        eq(t.groups.userId, userId),
        eq(t.groups.agent, agent),
        eq(t.groups.windowStart, windowStart),
      ),
    );
}

export async function closeGroup(db: Q, userId: string, agent: string, windowStart: Date, now: Date): Promise<void> {
  await db
    .update(t.groups)
    .set({ closedAt: now })
    .where(
      and(
        eq(t.groups.userId, userId),
        eq(t.groups.agent, agent),
        eq(t.groups.windowStart, windowStart),
        isNull(t.groups.closedAt),
      ),
    );
}

// ---------- jobs ----------

export interface JobRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  runAt: Date;
  status: string;
  attempts: number;
}

export async function enqueueJob(
  db: Q,
  kind: string,
  payload: Record<string, unknown>,
  runAt: Date,
  dedupeKey?: string,
): Promise<void> {
  await db
    .insert(t.jobs)
    .values({ kind, payload, runAt, dedupeKey: dedupeKey ?? null })
    .onConflictDoNothing();
}

export async function claimDueJobs(db: Q, now: Date, limit: number): Promise<JobRow[]> {
  const rows = await db.execute(
    sql`UPDATE jobs SET status = 'running', locked_until = ${new Date(now.getTime() + 60_000).toISOString()}
        WHERE id IN (
          SELECT id FROM jobs
          WHERE status = 'pending' AND run_at <= ${now.toISOString()}
          ORDER BY run_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
  );
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: r['id'] as string,
    kind: r['kind'] as string,
    payload: r['payload'] as Record<string, unknown>,
    runAt: new Date(r['run_at'] as string),
    status: r['status'] as string,
    attempts: r['attempts'] as number,
  }));
}

export async function finishJob(db: Q, id: string, status: 'done' | 'pending' | 'failed', runAt?: Date): Promise<void> {
  if (status === 'pending' && runAt) {
    await db
      .update(t.jobs)
      .set({ status: 'pending', runAt, lockedUntil: null, attempts: sql`attempts + 1` })
      .where(eq(t.jobs.id, id));
  } else {
    await db
      .update(t.jobs)
      .set({ status, lockedUntil: null, ...(status === 'failed' ? { attempts: sql`attempts + 1` } : {}) })
      .where(eq(t.jobs.id, id));
  }
}

// ---------- rate limits ----------

/**
 * Fixed-window rate limiter. Returns null when allowed, or seconds until the
 * window resets when the limit is hit.
 */
export async function hitRateLimit(
  db: Q,
  key: string,
  windowSeconds: number,
  limit: number,
  now: Date,
): Promise<number | null> {
  const windowStart = new Date(Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const rows = await db.execute(
    sql`INSERT INTO rate_limits (key, window_start, count)
        VALUES (${key}, ${windowStart.toISOString()}, 1)
        ON CONFLICT (key) DO UPDATE
          SET count = CASE WHEN rate_limits.window_start = ${windowStart.toISOString()}
                           THEN rate_limits.count + 1 ELSE 1 END,
              window_start = ${windowStart.toISOString()}
        RETURNING count`,
  );
  const count = (rows as unknown as { count: number }[])[0]!.count;
  if (count <= limit) return null;
  return windowSeconds - Math.floor((now.getTime() - windowStart.getTime()) / 1000);
}

// ---------- usage ----------

export async function emailsSentThisMonth(db: Q, userId: string, now: Date): Promise<number> {
  const rows = await db
    .select({ emailsSent: t.usageMonthly.emailsSent })
    .from(t.usageMonthly)
    .where(and(eq(t.usageMonthly.userId, userId), eq(t.usageMonthly.month, monthKey(now))))
    .limit(1);
  return rows[0]?.emailsSent ?? 0;
}

export async function incrementEmailsSent(db: Q, userId: string, now: Date): Promise<void> {
  await db
    .insert(t.usageMonthly)
    .values({ userId, month: monthKey(now), emailsSent: 1 })
    .onConflictDoUpdate({
      target: [t.usageMonthly.userId, t.usageMonthly.month],
      set: { emailsSent: sql`${t.usageMonthly.emailsSent} + 1` },
    });
}

// ---------- system state ----------

export async function getSystemState(db: Q, key: string): Promise<string | null> {
  const rows = await db.select().from(t.systemState).where(eq(t.systemState.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

export async function setSystemState(db: Q, key: string, value: string): Promise<void> {
  await db
    .insert(t.systemState)
    .values({ key, value })
    .onConflictDoUpdate({ target: t.systemState.key, set: { value } });
}

/** Build the RouteState snapshot for routing an event for (userId, agent). */
export async function loadRouteState(
  db: Q,
  userId: string,
  agent: string,
  now: Date,
  awayMaxHours: number,
): Promise<import('./routing/route.js').RouteState> {
  const [user, devices, group] = await Promise.all([
    getUser(db, userId),
    listActiveDevices(db, userId, now),
    getOpenGroup(db, userId, agent),
  ]);
  return {
    now: now.getTime(),
    account: {
      notifyOnPhone: user?.notifyOnPhone ?? false,
      phoneAlertsSince: user?.phoneAlertsSince?.getTime() ?? null,
      emailVerified: user?.emailVerified ?? false,
    },
    activeDeviceIds: devices.map((d) => d.id),
    group: routeGroupFromRow(group),
    awayMaxHours,
  };
}

export function routeGroupFromRow(row: GroupRow | undefined): RouteGroup | null {
  if (!row) return null;
  return {
    windowStart: row.windowStart.getTime(),
    count: row.count,
    suppressed: row.suppressed,
  };
}
