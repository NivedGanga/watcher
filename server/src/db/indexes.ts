import type { Db as MongoDb } from 'mongodb';

/**
 * Collections and indexes — the Mongo equivalent of the old Drizzle schema +
 * migrations. Idempotent: safe to run at every boot.
 *
 * Primary keys map to `_id`:
 *   users, devices, machines, deliveries, jobs, device_authorizations → id
 *   events, signals → `${userId}:${id}`
 *   groups → `${userId}:${agent}:${windowStart.toISOString()}`
 *   rate_limits → key; usage_monthly → `${userId}:${month}`; system_state → key
 */
export const COLLECTIONS = [
  'users',
  'devices',
  'machines',
  'device_authorizations',
  'events',
  'signals',
  'deliveries',
  'groups',
  'jobs',
  'rate_limits',
  'usage_monthly',
  'system_state',
] as const;

export async function ensureIndexes(db: MongoDb): Promise<void> {
  const existing = new Set(await db.listCollections({}, { nameOnly: true }).toArray().then(
    (cols) => cols.map((c) => c.name),
  ));
  for (const name of COLLECTIONS) {
    if (!existing.has(name)) await db.createCollection(name);
  }

  await Promise.all([
    db.collection('users').createIndex({ firebaseUid: 1 }, { unique: true, name: 'users_firebase_uid' }),

    db.collection('devices').createIndex(
      { userId: 1, fcmTokenHash: 1 },
      { unique: true, name: 'devices_user_token_hash' },
    ),
    db.collection('devices').createIndex(
      { userId: 1, revokedAt: 1, lastSeenAt: 1 },
      { name: 'devices_user_active' },
    ),

    db.collection('machines').createIndex(
      { lastHeartbeatAt: 1, silentAlertedAt: 1 },
      { name: 'machines_silence' },
    ),

    db.collection('device_authorizations').createIndex(
      { deviceCodeHash: 1 },
      { unique: true, name: 'device_authorizations_device_code_hash' },
    ),
    db.collection('device_authorizations').createIndex(
      { userCodeHash: 1 },
      { unique: true, name: 'device_authorizations_user_code_hash' },
    ),
    db.collection('device_authorizations').createIndex(
      { expiresAt: 1 },
      { name: 'device_authorizations_expires' },
    ),

    db.collection('events').createIndex(
      { userId: 1, runId: 1, type: 1, summary: 1, eventTimestamp: 1 },
      { name: 'events_dedupe' },
    ),
    db.collection('events').createIndex(
      { machineId: 1, eventTimestamp: 1 },
      { name: 'events_machine_run' },
    ),

    db.collection('signals').createIndex(
      { userId: 1, runId: 1, kind: 1, at: 1 },
      { name: 'signals_reminder' },
    ),

    // Unique per (event, channel, deviceId-or-''): dedupe key computed at insert.
    db.collection('deliveries').createIndex({ dedupe: 1 }, { unique: true, name: 'deliveries_dedupe' }),
    db.collection('deliveries').createIndex(
      { status: 1, nextAttemptAt: 1 },
      { name: 'deliveries_due' },
    ),
    db.collection('deliveries').createIndex(
      { userId: 1, eventId: 1, channel: 1 },
      { name: 'deliveries_event' },
    ),

    db.collection('jobs').createIndex({ status: 1, runAt: 1 }, { name: 'jobs_due' }),
    db.collection('jobs').createIndex(
      { dedupeKey: 1 },
      {
        unique: true,
        name: 'jobs_dedupe',
        partialFilterExpression: { dedupeKey: { $type: 'string' } },
      },
    ),
  ]);
}
