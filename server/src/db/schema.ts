import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  firebaseUid: text('firebase_uid').notNull().unique(),
  email: text('email').notNull(),
  emailVerified: boolean('email_verified').notNull().default(false),
  notifyOnPhone: boolean('notify_on_phone').notNull().default(false),
  phoneAlertsSince: timestamp('phone_alerts_since', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const devices = pgTable(
  'devices',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    fcmTokenEnc: text('fcm_token_enc').notNull(),
    fcmTokenHash: text('fcm_token_hash').notNull(),
    deviceSecretHash: text('device_secret_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('devices_user_token_hash').on(t.userId, t.fcmTokenHash),
    index('devices_user_active').on(t.userId, t.revokedAt, t.lastSeenAt),
  ],
);

export const machines = pgTable(
  'machines',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    name: text('name').notNull(),
    os: text('os').notNull(),
    keyHash: text('key_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    activeRuns: integer('active_runs').notNull().default(0),
    silentAlertedAt: timestamp('silent_alerted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('machines_silence').on(t.lastHeartbeatAt, t.silentAlertedAt)],
);

export const deviceAuthorizations = pgTable(
  'device_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceCodeHash: text('device_code_hash').notNull().unique(),
    userCodeHash: text('user_code_hash').notNull().unique(),
    clientName: text('client_name').notNull(),
    clientOs: text('client_os').notNull(),
    status: text('status').notNull().default('pending'),
    userId: uuid('user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    intervalSeconds: integer('interval_seconds').notNull().default(5),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    sourceIpHash: text('source_ip_hash'),
  },
  (t) => [index('device_authorizations_expires').on(t.expiresAt)],
);

export const events = pgTable(
  'events',
  {
    userId: uuid('user_id').notNull().references(() => users.id),
    id: uuid('id').notNull(),
    machineId: text('machine_id').notNull().references(() => machines.id),
    agent: text('agent').notNull(),
    runId: text('run_id').notNull(),
    host: text('host').notNull(),
    type: text('type').notNull(),
    blocking: boolean('blocking').notNull(),
    summary: text('summary').notNull(),
    exitCode: integer('exit_code'),
    durationS: doublePrecision('duration_s'),
    emailAllowed: boolean('email_allowed').notNull(),
    eventTimestamp: timestamp('event_timestamp', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    routing: text('routing').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('events_dedupe').on(t.userId, t.runId, t.type, t.summary, t.eventTimestamp),
    index('events_machine_run').on(t.machineId, t.eventTimestamp),
  ],
);

export const signals = pgTable(
  'signals',
  {
    userId: uuid('user_id').notNull().references(() => users.id),
    id: uuid('id').notNull(),
    machineId: text('machine_id').notNull().references(() => machines.id),
    kind: text('kind').notNull(),
    runId: text('run_id'),
    at: timestamp('at', { withTimezone: true }).notNull(),
    idleSeconds: doublePrecision('idle_seconds'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index('signals_reminder').on(t.userId, t.runId, t.kind, t.at),
  ],
);

export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    eventId: uuid('event_id').notNull(),
    channel: text('channel').notNull(),
    deviceId: text('device_id'),
    status: text('status').notNull().default('pending'),
    skipReason: text('skip_reason'),
    payload: jsonb('payload'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    ackedAt: timestamp('acked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('deliveries_event_channel_device').on(
      t.eventId,
      t.channel,
      sql`coalesce(${t.deviceId}, '')`,
    ),
    index('deliveries_due').on(t.status, t.nextAttemptAt),
    index('deliveries_event').on(t.userId, t.eventId, t.channel),
  ],
);

export const groups = pgTable(
  'groups',
  {
    userId: uuid('user_id').notNull().references(() => users.id),
    agent: text('agent').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
    suppressed: integer('suppressed').notNull().default(0),
    latestEventId: uuid('latest_event_id'),
    latestSummary: text('latest_summary'),
    triggerEventId: uuid('trigger_event_id'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.agent, t.windowStart] })],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    dedupeKey: text('dedupe_key'),
    runAt: timestamp('run_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('jobs_due').on(t.status, t.runAt),
    uniqueIndex('jobs_dedupe').on(t.dedupeKey),
  ],
);

export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
});

export const usageMonthly = pgTable(
  'usage_monthly',
  {
    userId: uuid('user_id').notNull().references(() => users.id),
    month: text('month').notNull(),
    emailsSent: integer('emails_sent').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.month] })],
);

export const systemState = pgTable('system_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
