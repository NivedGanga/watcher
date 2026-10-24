import { sql } from 'drizzle-orm';
import { createDb, type Db } from '../src/db/client.js';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type {
  Deps,
  AuthProvider,
  VerifiedToken,
  PushProvider,
  PushMessage,
  EmailProvider,
  EmailMessage,
  HealthCheck,
} from '../src/providers/types.js';
import { PushError } from '../src/providers/types.js';
import { PostgresJobRunner } from '../src/providers/jobs.js';
import { hmac, aesGcmEncrypt, randomId, randomSecret } from '../src/lib/crypto.js';
import * as repo from '../src/repo.js';
import { runTick } from '../src/worker/tick.js';

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/agentwatch_test';

const shared = createDb(TEST_DATABASE_URL);
export const db: Db = shared.db;

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: TEST_DATABASE_URL,
    firebaseProjectId: 'test-project',
    firebaseServiceAccountJsonB64: Buffer.from('{}').toString('base64'),
    resendApiKey: 're_test',
    emailFrom: 'alerts@example.com',
    appUrl: 'https://app.example.com',
    corsOrigin: 'https://app.example.com',
    deviceTokenEncKey: Buffer.alloc(32, 7).toString('base64'),
    machineKeyPepper: 'test-pepper',
    cronSecret: 'cron-secret-value',
    healthcheckUrl: 'https://hc.example.com/ping/1',
    awayMaxHours: 8,
    returnIdleMinutes: 5,
    ...overrides,
  };
}

export class FakeAuthProvider implements AuthProvider {
  tokens = new Map<string, VerifiedToken>();
  addToken(token: string, v: VerifiedToken) {
    this.tokens.set(token, v);
    return token;
  }
  async verifyIdToken(token: string): Promise<VerifiedToken | null> {
    return this.tokens.get(token) ?? null;
  }
}

export interface SentPush extends PushMessage {}

export class FakePushProvider implements PushProvider {
  sent: SentPush[] = [];
  failures = new Map<string, string>(); // token -> error code to throw
  failAll: string | null = null;

  failWith(code: string) {
    this.failAll = code;
  }
  failToken(token: string, code: string) {
    this.failures.set(token, code);
  }
  async send(message: PushMessage): Promise<void> {
    const code = this.failures.get(message.token) ?? this.failAll;
    if (code) throw new PushError(code, 'fcm error');
    this.sent.push(message);
  }
  reset() {
    this.sent = [];
    this.failures.clear();
    this.failAll = null;
  }
}

export class FakeEmailProvider implements EmailProvider {
  sent: EmailMessage[] = [];
  failAll = false;
  async send(message: EmailMessage): Promise<void> {
    if (this.failAll) throw new Error('resend error');
    this.sent.push(message);
  }
  reset() {
    this.sent = [];
    this.failAll = false;
  }
}

export class FakeHealthCheck implements HealthCheck {
  pings: string[] = [];
  fail = false;
  async ping(url: string): Promise<void> {
    if (this.fail) throw new Error('ping failed');
    this.pings.push(url);
  }
}

export interface TestDeps extends Deps {
  auth: FakeAuthProvider;
  push: FakePushProvider;
  email: FakeEmailProvider;
  healthcheck: FakeHealthCheck;
}

export function makeDeps(): TestDeps {
  return {
    auth: new FakeAuthProvider(),
    push: new FakePushProvider(),
    email: new FakeEmailProvider(),
    jobs: new PostgresJobRunner(db),
    healthcheck: new FakeHealthCheck(),
  };
}

export const config = testConfig();
export const deps = makeDeps();
export const app = createApp({ config, deps, db });

export async function resetDb() {
  await db.execute(sql`TRUNCATE TABLE
    deliveries, events, signals, groups, jobs, rate_limits,
    usage_monthly, system_state, device_authorizations,
    devices, machines, users RESTART IDENTITY CASCADE`);
  deps.push.reset();
  deps.email.reset();
  deps.healthcheck.pings = [];
  deps.healthcheck.fail = false;
}

// ---------- seeding ----------

export interface SeedUser {
  userId: string;
  token: string;
  email: string;
}

export async function seedUser(opts: {
  email: string;
  verified?: boolean;
  notifyOnPhone?: boolean;
  phoneAlertsSince?: Date | null;
}): Promise<SeedUser> {
  const token = `token-${opts.email}`;
  deps.auth.addToken(token, {
    uid: `uid-${opts.email}`,
    email: opts.email,
    emailVerified: opts.verified ?? true,
  });
  const user = await repo.upsertUserFromToken(db, {
    firebaseUid: `uid-${opts.email}`,
    email: opts.email,
    emailVerified: opts.verified ?? true,
  });
  if (opts.notifyOnPhone !== undefined || opts.phoneAlertsSince !== undefined) {
    await db.execute(
      sql`UPDATE users SET notify_on_phone = ${opts.notifyOnPhone ?? false},
          phone_alerts_since = ${opts.phoneAlertsSince ? opts.phoneAlertsSince.toISOString() : null} WHERE id = ${user.id}`,
    );
  }
  return { userId: user.id, token, email: opts.email };
}

export interface SeedMachine {
  machineId: string;
  key: string;
}

export async function seedMachine(
  userId: string,
  opts: { id?: string; name?: string; os?: string; revoked?: boolean; lastHeartbeatAt?: Date | null; activeRuns?: number; silentAlertedAt?: Date | null } = {},
): Promise<SeedMachine> {
  const machineId = opts.id ?? randomId('m');
  const secret = randomSecret(32);
  await repo.insertMachine(db, {
    id: machineId,
    userId,
    name: opts.name ?? 'workstation',
    os: opts.os ?? 'macos',
    keyHash: hmac(config.machineKeyPepper, `mk:${secret}`),
  });
  if (opts.lastHeartbeatAt !== undefined || opts.activeRuns !== undefined || opts.silentAlertedAt !== undefined || opts.revoked) {
    await db.execute(
      sql`UPDATE machines SET
        last_heartbeat_at = ${opts.lastHeartbeatAt ? opts.lastHeartbeatAt.toISOString() : null},
        active_runs = ${opts.activeRuns ?? 0},
        silent_alerted_at = ${opts.silentAlertedAt ? opts.silentAlertedAt.toISOString() : null},
        revoked_at = ${opts.revoked ? new Date().toISOString() : null}
        WHERE id = ${machineId}`,
    );
  }
  return { machineId, key: `aw_${machineId}_${secret}` };
}

export interface SeedDevice {
  deviceId: string;
  secret: string;
  token: string;
}

export async function seedDevice(
  userId: string,
  opts: { id?: string; lastSeenAt?: Date; revoked?: boolean; token?: string } = {},
): Promise<SeedDevice> {
  const deviceId = opts.id ?? randomId('d');
  const secret = randomSecret(32);
  const token = opts.token ?? `fcm-${deviceId}`;
  await repo.insertDevice(db, {
    id: deviceId,
    userId,
    fcmTokenEnc: aesGcmEncrypt(config.deviceTokenEncKey, token),
    fcmTokenHash: hmac(config.machineKeyPepper, `fcm:${token}`),
    deviceSecretHash: hmac(config.machineKeyPepper, `devsecret:${secret}`),
  });
  if (opts.lastSeenAt || opts.revoked) {
    await db.execute(
      sql`UPDATE devices SET last_seen_at = ${(opts.lastSeenAt ?? new Date()).toISOString()},
          revoked_at = ${opts.revoked ? new Date().toISOString() : null} WHERE id = ${deviceId}`,
    );
  }
  return { deviceId, secret, token };
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'X-AgentWatch-Protocol': '1' };
}

export const PROTOCOL = { 'X-AgentWatch-Protocol': '1' };

export function uuid(): string {
  return crypto.randomUUID();
}

export function makeEvent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: uuid(),
    agent: 'agent-a',
    run_id: 'r1',
    host: 'workstation',
    type: 'done',
    blocking: false,
    summary: 'Run finished',
    exit_code: 0,
    duration_s: 10,
    email_allowed: true,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...overrides,
  };
}

export async function postEvents(key: string, events: Record<string, unknown>[]) {
  return app.request('/api/events', {
    method: 'POST',
    headers: { ...authHeaders(key), 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  });
}

export async function tick(now?: Date) {
  return runTick(db, deps, config, now);
}
