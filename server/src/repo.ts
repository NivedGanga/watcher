/**
 * All persistence for the server lives here — the only module that queries
 * the database. Implemented on the MongoDB driver; documents store the same
 * camelCase fields the row interfaces declare, plus `_id` as the physical key.
 *
 * `_id` layout:  users/devices/machines/deliveries/jobs/device_authorizations
 * use their `id`; events/signals use `${userId}:${id}`; groups use
 * `${userId}:${agent}:${windowStartISO}`; rate_limits/system_state use the
 * key; usage_monthly uses `${userId}:${month}`.
 *
 * Transactions: callers pass a `Q` bound to a session (see db/client.ts).
 * `lockUser`/`lockAuthBy*` write-touch a document so concurrent transactions
 * on it produce a write conflict — the driver's withTransaction retry gives
 * the same serialization `SELECT ... FOR UPDATE` provided.
 */

import { randomUUID } from 'node:crypto';
import type { ClientSession, Collection } from 'mongodb';
import type { Q } from './db/client.js';
import { monthKey, DEVICE_ACTIVE_WINDOW_MS } from './lib/time.js';
import type { RouteGroup } from './routing/route.js';

export type { Q };
export const asDb = (tx: unknown): Q => tx as Q;

const S = (q: Q): { session?: ClientSession } => (q.session ? { session: q.session } : {});

/** All documents key on a string `_id`. */
type Doc = { _id: string } & Record<string, any>;

const col = (q: Q, name: string): Collection<Doc> => q.db.collection<Doc>(name);

const isDupKey = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;

/** Strip the physical `_id`; documents carry logical `id` as a field. */
const unpack = <T>(doc: Doc | null | undefined): T | undefined => {
  if (!doc) return undefined;
  const { _id, ...rest } = doc;
  return rest as T;
};

const unpackAll = <T>(docs: Doc[]): T[] => docs.map((d) => unpack<T>(d)!);

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
  const id = randomUUID();
  await col(db, 'users').updateOne(
    { firebaseUid: input.firebaseUid },
    {
      $set: { email: input.email, emailVerified: input.emailVerified },
      $setOnInsert: {
        _id: id,
        id,
        firebaseUid: input.firebaseUid,
        notifyOnPhone: false,
        phoneAlertsSince: null,
        createdAt: new Date(),
        deletedAt: null,
      },
    },
    { upsert: true, ...S(db) },
  );
  const doc = await col(db, 'users')
    .findOne({ firebaseUid: input.firebaseUid }, S(db));
  return unpack<UserRow>(doc)!;
}

export async function getUser(db: Q, userId: string): Promise<UserRow | undefined> {
  const doc = await col(db, 'users').findOne({ _id: userId }, S(db));
  return unpack<UserRow>(doc);
}

export async function lockUser(db: Q, userId: string): Promise<UserRow | undefined> {
  // Write-touch the user doc so concurrent transactions conflict and retry —
  // the Mongo equivalent of SELECT ... FOR UPDATE.
  const doc = await col(db, 'users').findOneAndUpdate(
    { _id: userId },
    { $currentDate: { lockTouchedAt: true } },
    { returnDocument: 'after', ...S(db) },
  );
  return unpack<UserRow>(doc);
}

export async function setNotifyFlag(db: Q, userId: string, enabled: boolean, now: Date): Promise<void> {
  await col(db, 'users').updateOne(
    { _id: userId },
    enabled
      ? { $set: { notifyOnPhone: true, phoneAlertsSince: now } }
      : { $set: { notifyOnPhone: false } },
    S(db),
  );
}

/** Hard-cap sweep: turn off flags past the deadline. Returns affected user ids. */
export async function hardCapSweep(db: Q, now: Date, awayMaxMs: number): Promise<string[]> {
  const deadline = new Date(now.getTime() - awayMaxMs);
  const users = col(db, 'users');
  const docs = await users
    .find(
      {
        notifyOnPhone: true,
        phoneAlertsSince: { $ne: null, $lte: deadline },
        deletedAt: null,
      },
      { projection: { _id: 1 }, ...S(db) },
    )
    .toArray();
  const ids = docs.map((d) => d._id as string);
  if (ids.length > 0) {
    await users.updateMany({ _id: { $in: ids } }, { $set: { notifyOnPhone: false } }, S(db));
  }
  return ids;
}

export async function deleteAccount(db: Q, userId: string): Promise<void> {
  const now = new Date();
  await col(db, 'deliveries').deleteMany({ userId }, S(db));
  await col(db, 'events').deleteMany({ userId }, S(db));
  await col(db, 'signals').deleteMany({ userId }, S(db));
  await col(db, 'groups').deleteMany({ userId }, S(db));
  await col(db, 'usage_monthly').deleteMany({ userId }, S(db));
  await col(db, 'jobs')
    .deleteMany({ status: 'pending', 'payload.user_id': userId }, S(db));
  await col(db, 'rate_limits')
    .deleteMany({ _id: { $regex: `^u:${userId}:` } }, S(db));
  await col(db, 'device_authorizations')
    .updateMany(
      { userId, status: 'pending' },
      { $set: { status: 'expired' } },
      S(db),
    );
  await col(db, 'devices')
    .updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now } }, S(db));
  await col(db, 'machines')
    .updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now } }, S(db));
  await col(db, 'users')
    .updateOne({ _id: userId }, { $set: { deletedAt: now } }, S(db));
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
  const doc = await col(db, 'devices').findOne({ _id: deviceId }, S(db));
  return unpack<DeviceRow>(doc);
}

export async function findDeviceByTokenHash(db: Q, userId: string, hash: string): Promise<DeviceRow | undefined> {
  const doc = await col(db, 'devices')
    .findOne({ userId, fcmTokenHash: hash }, S(db));
  return unpack<DeviceRow>(doc);
}

export async function countLiveDevices(db: Q, userId: string): Promise<number> {
  return col(db, 'devices')
    .countDocuments({ userId, revokedAt: null }, S(db));
}

export async function insertDevice(
  db: Q,
  row: { id: string; userId: string; fcmTokenEnc: string; fcmTokenHash: string; deviceSecretHash: string },
): Promise<void> {
  await col(db, 'devices').insertOne(
    {
      _id: row.id,
      ...row,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      revokedAt: null,
    },
    S(db),
  );
}

export async function rotateDeviceSecret(
  db: Q,
  deviceId: string,
  deviceSecretHash: string,
  now: Date,
): Promise<void> {
  await col(db, 'devices').updateOne(
    { _id: deviceId },
    { $set: { deviceSecretHash, lastSeenAt: now, revokedAt: null } },
    S(db),
  );
}

export async function revokeDevice(db: Q, userId: string, deviceId: string, now: Date): Promise<boolean> {
  const res = await col(db, 'devices').updateOne(
    { _id: deviceId, userId, revokedAt: null },
    { $set: { revokedAt: now } },
    S(db),
  );
  return res.modifiedCount > 0;
}

export async function revokeDeviceById(db: Q, deviceId: string, now: Date): Promise<void> {
  await col(db, 'devices')
    .updateOne({ _id: deviceId }, { $set: { revokedAt: now } }, S(db));
}

export async function touchDeviceSeen(db: Q, deviceId: string, now: Date): Promise<void> {
  await col(db, 'devices')
    .updateOne({ _id: deviceId }, { $set: { lastSeenAt: now } }, S(db));
}

/** Devices eligible for pushes: not revoked AND last seen strictly within 14 days. */
export async function listActiveDevices(db: Q, userId: string, now: Date): Promise<DeviceRow[]> {
  const cutoff = new Date(now.getTime() - DEVICE_ACTIVE_WINDOW_MS);
  const docs = await col(db, 'devices')
    .find({ userId, revokedAt: null, lastSeenAt: { $gt: cutoff } }, S(db))
    .toArray();
  return unpackAll<DeviceRow>(docs);
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
  const doc = await col(db, 'machines').findOne({ _id: machineId }, S(db));
  return unpack<MachineRow>(doc);
}

export async function countLiveMachines(db: Q, userId: string): Promise<number> {
  return col(db, 'machines').countDocuments({ userId, revokedAt: null }, S(db));
}

export async function insertMachine(
  db: Q,
  row: { id: string; userId: string; name: string; os: string; keyHash: string },
): Promise<void> {
  await col(db, 'machines').insertOne(
    {
      _id: row.id,
      ...row,
      createdAt: new Date(),
      lastHeartbeatAt: null,
      activeRuns: 0,
      silentAlertedAt: null,
      revokedAt: null,
    },
    S(db),
  );
}

export async function listMachines(db: Q, userId: string): Promise<MachineRow[]> {
  const docs = await col(db, 'machines')
    .find({ userId, revokedAt: null }, S(db))
    .sort({ createdAt: 1 })
    .toArray();
  return unpackAll<MachineRow>(docs);
}

export async function revokeMachine(db: Q, userId: string, machineId: string, now: Date): Promise<boolean> {
  const res = await col(db, 'machines').updateOne(
    { _id: machineId, userId, revokedAt: null },
    { $set: { revokedAt: now } },
    S(db),
  );
  return res.modifiedCount > 0;
}

export async function recordHeartbeat(
  db: Q,
  machineId: string,
  activeRuns: number,
  now: Date,
): Promise<void> {
  await col(db, 'machines').updateOne(
    { _id: machineId },
    { $set: { lastHeartbeatAt: now, activeRuns, silentAlertedAt: null } },
    S(db),
  );
}

/** Machines silent at `now` that haven't been marked yet. */
export async function silentMachines(db: Q, now: Date, thresholdMs: number): Promise<MachineRow[]> {
  const cutoff = new Date(now.getTime() - thresholdMs);
  const docs = await col(db, 'machines')
    .find(
      {
        revokedAt: null,
        silentAlertedAt: null,
        lastHeartbeatAt: { $lt: cutoff },
      },
      S(db),
    )
    .toArray();
  return unpackAll<MachineRow>(docs);
}

export async function markSilentAlerted(db: Q, machineId: string, now: Date): Promise<void> {
  await col(db, 'machines')
    .updateOne({ _id: machineId }, { $set: { silentAlertedAt: now } }, S(db));
}

/** Most recent run_id reported by a machine, or null. */
export async function latestRunId(db: Q, userId: string, machineId: string): Promise<string | null> {
  const doc = await col(db, 'events')
    .find({ userId, machineId }, { projection: { runId: 1 }, ...S(db) })
    .sort({ eventTimestamp: -1 })
    .limit(1)
    .next();
  return (doc?.runId as string | undefined) ?? null;
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
  const id = randomUUID();
  await col(db, 'device_authorizations').insertOne(
    {
      _id: id,
      id,
      ...row,
      status: 'pending',
      userId: null,
      createdAt: new Date(),
      lastPolledAt: null,
    },
    S(db),
  );
}

export async function findAuthByDeviceCode(db: Q, deviceCodeHash: string): Promise<AuthorizationRow | undefined> {
  const doc = await col(db, 'device_authorizations')
    .findOne({ deviceCodeHash }, S(db));
  return unpack<AuthorizationRow>(doc);
}

export async function findAuthByUserCode(db: Q, userCodeHash: string): Promise<AuthorizationRow | undefined> {
  const doc = await col(db, 'device_authorizations')
    .findOne({ userCodeHash }, S(db));
  return unpack<AuthorizationRow>(doc);
}

/** Lock via a write-touch so concurrent transactions conflict and retry. */
async function lockAuth(db: Q, filter: Record<string, unknown>): Promise<AuthorizationRow | undefined> {
  const doc = await col(db, 'device_authorizations').findOneAndUpdate(
    filter,
    { $currentDate: { lockTouchedAt: true } },
    { returnDocument: 'after', ...S(db) },
  );
  return unpack<AuthorizationRow>(doc);
}

export async function lockAuthByUserCode(db: Q, userCodeHash: string): Promise<AuthorizationRow | undefined> {
  return lockAuth(db, { userCodeHash });
}

export async function lockAuthByDeviceCode(db: Q, deviceCodeHash: string): Promise<AuthorizationRow | undefined> {
  return lockAuth(db, { deviceCodeHash });
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
  await col(db, 'device_authorizations')
    .updateOne({ _id: id }, { $set: set }, S(db));
}

export async function deleteExpiredAuthorizations(db: Q, now: Date): Promise<void> {
  await col(db, 'device_authorizations')
    .deleteMany({ expiresAt: { $lt: now } }, S(db));
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

const eventKey = (userId: string, id: string) => `${userId}:${id}`;

export async function eventExists(db: Q, userId: string, id: string): Promise<boolean> {
  const doc = await col(db, 'events')
    .findOne({ _id: eventKey(userId, id) }, { projection: { _id: 1 }, ...S(db) });
  return doc !== null;
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
  const doc = await col(db, 'events').findOne(
    {
      userId,
      runId,
      type,
      summary,
      eventTimestamp: { $gt: lo, $lt: hi },
    },
    { projection: { _id: 1 }, ...S(db) },
  );
  return doc !== null;
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
  await col(db, 'events').insertOne(
    { _id: eventKey(row.userId, row.id), ...row, receivedAt: new Date() },
    S(db),
  );
}

export async function getEvent(db: Q, userId: string, id: string): Promise<EventRow | undefined> {
  const doc = await col(db, 'events')
    .findOne({ _id: eventKey(userId, id) }, S(db));
  return unpack<EventRow>(doc);
}

export async function listRecentEvents(
  db: Q,
  userId: string,
  limit: number,
): Promise<EventRow[]> {
  const docs = await col(db, 'events')
    .find({ userId }, { sort: { receivedAt: -1 }, limit, ...S(db) })
    .toArray();
  return docs.map((d) => unpack<EventRow>(d)!);
}

export async function deleteOldEvents(db: Q, cutoff: Date): Promise<void> {
  const stale = await col(db, 'events')
    .find({ receivedAt: { $lt: cutoff } }, { projection: { userId: 1, id: 1 }, ...S(db) })
    .toArray();
  if (stale.length > 0) {
    await col(db, 'deliveries').deleteMany(
      { $or: stale.map((e) => ({ userId: e.userId, eventId: e.id })) },
      S(db),
    );
  }
  await col(db, 'events').deleteMany({ receivedAt: { $lt: cutoff } }, S(db));
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
  try {
    await col(db, 'signals').insertOne(
      { _id: `${row.userId}:${row.id}`, ...row, receivedAt: new Date() },
      S(db),
    );
    return 'inserted';
  } catch (err) {
    if (isDupKey(err)) return 'duplicate';
    throw err;
  }
}

export async function hasOutputSeen(db: Q, userId: string, runId: string, atOrAfter: Date): Promise<boolean> {
  const doc = await col(db, 'signals').findOne(
    { userId, kind: 'output_seen', runId, at: { $gte: atOrAfter } },
    { projection: { _id: 1 }, ...S(db) },
  );
  return doc !== null;
}

export async function deleteOldSignals(db: Q, cutoff: Date): Promise<void> {
  await col(db, 'signals').deleteMany({ receivedAt: { $lt: cutoff } }, S(db));
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

const deliveryDedupe = (eventId: string, channel: string, deviceId: string | null) =>
  `${eventId}|${channel}|${deviceId ?? ''}`;

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
  const id = randomUUID();
  const dedupe = deliveryDedupe(row.eventId, row.channel, row.deviceId);
  try {
    await col(db, 'deliveries').insertOne(
      {
        _id: id,
        id,
        userId: row.userId,
        eventId: row.eventId,
        channel: row.channel,
        deviceId: row.deviceId,
        dedupe,
        status: row.status ?? 'pending',
        skipReason: row.skipReason ?? null,
        payload: row.payload ?? null,
        attempts: 0,
        nextAttemptAt: row.nextAttemptAt ?? new Date(),
        sentAt: null,
        ackedAt: null,
      },
      S(db),
    );
    return id;
  } catch (err) {
    if (!isDupKey(err)) throw err;
  }
  // already exists (idempotent retry): return existing id
  const existing = await col(db, 'deliveries')
    .findOne({ dedupe }, { projection: { id: 1 }, ...S(db) });
  return existing!.id as string;
}

export async function getDelivery(db: Q, id: string): Promise<DeliveryRow | undefined> {
  const doc = await col(db, 'deliveries').findOne({ _id: id }, S(db));
  return unpack<DeliveryRow>(doc);
}

export async function dueDeliveries(db: Q, now: Date, limit: number): Promise<DeliveryRow[]> {
  const docs = await col(db, 'deliveries')
    .find({ status: 'pending', nextAttemptAt: { $lte: now } }, S(db))
    .sort({ nextAttemptAt: 1 })
    .limit(limit)
    .toArray();
  return unpackAll<DeliveryRow>(docs);
}

/**
 * Claim a pending delivery by bumping attempts and pushing next_attempt_at
 * forward. Returns the claimed row, or undefined if another worker took it.
 */
export async function claimDelivery(db: Q, id: string, now: Date): Promise<DeliveryRow | undefined> {
  const doc = await col(db, 'deliveries').findOneAndUpdate(
    { _id: id, status: 'pending', nextAttemptAt: { $lte: now } },
    { $inc: { attempts: 1 }, $set: { nextAttemptAt: new Date(now.getTime() + 600_000) } },
    { returnDocument: 'after', ...S(db) },
  );
  return unpack<DeliveryRow>(doc);
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
  await col(db, 'deliveries').updateOne({ _id: id }, { $set: set }, S(db));
}

export async function ackDelivery(
  db: Q,
  deliveryId: string,
  deviceId: string,
  now: Date,
): Promise<DeliveryRow | undefined> {
  const doc = await col(db, 'deliveries').findOneAndUpdate(
    { _id: deliveryId, deviceId, channel: 'push' },
    { $set: { status: 'acked', ackedAt: now } },
    { returnDocument: 'after', ...S(db) },
  );
  return unpack<DeliveryRow>(doc);
}

export async function eventHasAckedPush(db: Q, userId: string, eventId: string): Promise<boolean> {
  const doc = await col(db, 'deliveries').findOne(
    { userId, eventId, channel: 'push', status: 'acked' },
    { projection: { _id: 1 }, ...S(db) },
  );
  return doc !== null;
}

export async function getEmailDelivery(db: Q, eventId: string): Promise<DeliveryRow | undefined> {
  const doc = await col(db, 'deliveries')
    .findOne({ eventId, channel: 'email' }, S(db));
  return unpack<DeliveryRow>(doc);
}

export async function hasEmailDelivery(db: Q, eventId: string): Promise<boolean> {
  const doc = await col(db, 'deliveries')
    .findOne({ eventId, channel: 'email' }, { projection: { _id: 1 }, ...S(db) });
  return doc !== null;
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

const groupKey = (userId: string, agent: string, windowStart: Date) =>
  `${userId}:${agent}:${windowStart.toISOString()}`;

export async function getOpenGroup(db: Q, userId: string, agent: string): Promise<GroupRow | undefined> {
  const doc = await col(db, 'groups')
    .find({ userId, agent, closedAt: null }, S(db))
    .sort({ windowStart: -1 })
    .limit(1)
    .next();
  return unpack<GroupRow>(doc);
}

export async function getGroup(db: Q, userId: string, agent: string, windowStart: Date): Promise<GroupRow | undefined> {
  const doc = await col(db, 'groups')
    .findOne({ _id: groupKey(userId, agent, windowStart) }, S(db));
  return unpack<GroupRow>(doc);
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
  const _id = groupKey(userId, agent, windowStart);
  if (u.action === 'create') {
    await col(db, 'groups').updateOne(
      { _id },
      {
        $set: {
          count: u.count,
          suppressed: u.suppressed,
          latestEventId: u.latestEventId,
          latestSummary: u.latestSummary,
          closedAt: null,
        },
        $setOnInsert: { userId, agent, windowStart, triggerEventId: null },
      },
      { upsert: true, ...S(db) },
    );
    return;
  }
  const set: Record<string, unknown> = {
    count: u.count,
    suppressed: u.suppressed,
    latestEventId: u.latestEventId,
    latestSummary: u.latestSummary,
  };
  if (u.triggerEventId) set['triggerEventId'] = u.triggerEventId;
  await col(db, 'groups').updateOne({ _id }, { $set: set }, S(db));
}

export async function closeGroup(db: Q, userId: string, agent: string, windowStart: Date, now: Date): Promise<void> {
  await col(db, 'groups').updateOne(
    { _id: groupKey(userId, agent, windowStart), closedAt: null },
    { $set: { closedAt: now } },
    S(db),
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
  const id = randomUUID();
  try {
    await col(db, 'jobs').insertOne(
      {
        _id: id,
        id,
        kind,
        payload,
        dedupeKey: dedupeKey ?? null,
        runAt,
        status: 'pending',
        attempts: 0,
        lockedUntil: null,
        createdAt: new Date(),
      },
      S(db),
    );
  } catch (err) {
    if (!isDupKey(err)) throw err;
  }
}

/**
 * Claim due jobs: repeatedly grab the earliest pending job atomically — the
 * Mongo equivalent of `FOR UPDATE SKIP LOCKED` (each findOneAndUpdate only
 * matches a job no other worker has claimed).
 */
export async function claimDueJobs(db: Q, now: Date, limit: number): Promise<JobRow[]> {
  const jobs = col(db, 'jobs');
  const claimed: JobRow[] = [];
  const lockedUntil = new Date(now.getTime() + 60_000);
  for (let i = 0; i < limit; i++) {
    const doc = await jobs.findOneAndUpdate(
      { status: 'pending', runAt: { $lte: now } },
      { $set: { status: 'running', lockedUntil } },
      { sort: { runAt: 1 }, returnDocument: 'after', ...S(db) },
    );
    if (!doc) break;
    claimed.push(unpack<JobRow>(doc)!);
  }
  return claimed;
}

export async function finishJob(db: Q, id: string, status: 'done' | 'pending' | 'failed', runAt?: Date): Promise<void> {
  if (status === 'pending' && runAt) {
    await col(db, 'jobs').updateOne(
      { _id: id },
      { $set: { status: 'pending', runAt, lockedUntil: null }, $inc: { attempts: 1 } },
      S(db),
    );
  } else {
    await col(db, 'jobs').updateOne(
      { _id: id },
      {
        $set: { status, lockedUntil: null },
        ...(status === 'failed' ? { $inc: { attempts: 1 } } : {}),
      },
      S(db),
    );
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
  const doc = await col(db, 'rate_limits').findOneAndUpdate(
    { _id: key },
    [
      {
        $set: {
          count: {
            $cond: [
              { $eq: ['$windowStart', windowStart] },
              { $add: [{ $ifNull: ['$count', 0] }, 1] },
              1,
            ],
          },
          windowStart,
        },
      },
    ],
    { upsert: true, returnDocument: 'after', ...S(db) },
  );
  const count = doc!.count as number;
  if (count <= limit) return null;
  return windowSeconds - Math.floor((now.getTime() - windowStart.getTime()) / 1000);
}

// ---------- usage ----------

const usageKey = (userId: string, month: string) => `${userId}:${month}`;

export async function emailsSentThisMonth(db: Q, userId: string, now: Date): Promise<number> {
  const doc = await col(db, 'usage_monthly')
    .findOne({ _id: usageKey(userId, monthKey(now)) }, { projection: { emailsSent: 1 }, ...S(db) });
  return (doc?.emailsSent as number | undefined) ?? 0;
}

export async function incrementEmailsSent(db: Q, userId: string, now: Date): Promise<void> {
  const month = monthKey(now);
  await col(db, 'usage_monthly').updateOne(
    { _id: usageKey(userId, month) },
    { $inc: { emailsSent: 1 }, $setOnInsert: { userId, month } },
    { upsert: true, ...S(db) },
  );
}

// ---------- system state ----------

export async function getSystemState(db: Q, key: string): Promise<string | null> {
  const doc = await col(db, 'system_state')
    .findOne({ _id: key }, { projection: { value: 1 }, ...S(db) });
  return (doc?.value as string | undefined) ?? null;
}

export async function setSystemState(db: Q, key: string, value: string): Promise<void> {
  await col(db, 'system_state')
    .updateOne({ _id: key }, { $set: { value } }, { upsert: true, ...S(db) });
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
