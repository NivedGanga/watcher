import { Hono } from 'hono';
import type { Vars } from '../middleware/auth.js';
import {
  firebaseAuth,
  requireVerified,
  getConfig,
  getDb,
  getDeps,
  getPrincipal,
} from '../middleware/auth.js';
import { validationFailed, notFound, limitReached, rateLimited, unauthorized } from '../lib/errors.js';
import { validateBody, isNonEmptyString } from '../lib/validate.js';
import { rfc3339, MACHINE_LIMIT } from '../lib/time.js';
import * as repo from '../repo.js';
import {
  generateUserCode,
  normalizeUserCode,
  formatUserCode,
  hmac,
  randomId,
  randomSecret,
} from '../lib/crypto.js';
import { log } from '../lib/logger.js';

export const enrollRoutes = new Hono<{ Variables: Vars }>();

const EXPIRES_IN_S = 600;
const BASE_INTERVAL_S = 5;

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return c.req.header('x-real-ip') ?? 'unknown';
}

function normalizeField(v: string, max: number): string {
  // strip control characters, cap length
  return v.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
}

enrollRoutes.post('/api/device/start', async (c) => {
  const db = getDb(c);
  const config = getConfig(c);
  const now = new Date();
  const ipHash = hmac(config.machineKeyPepper, `ip:${clientIp(c)}`);
  const retry = await repo.hitRateLimit(db, `device_start:${ipHash}`, 3600, 10, now);
  if (retry !== null) return rateLimited(c, retry);

  const body = await c.req.json().catch(() => null);
  const v = validateBody<{ client_name: string; client_os: string }>(body, {
    client_name: isNonEmptyString(128),
    client_os: isNonEmptyString(128),
  });
  if (!v.ok) return validationFailed(c, v.reason);

  const clientName = normalizeField(v.value.client_name, 64);
  const clientOs = normalizeField(v.value.client_os, 64);
  if (!clientName || !clientOs) return validationFailed(c);

  const deviceCode = randomSecret(48);
  const userCode = generateUserCode();
  const normalized = normalizeUserCode(userCode)!;
  await repo.insertAuthorization(db, {
    deviceCodeHash: hmac(config.machineKeyPepper, `dc:${deviceCode}`),
    userCodeHash: hmac(config.machineKeyPepper, `uc:${normalized}`),
    clientName,
    clientOs,
    expiresAt: new Date(now.getTime() + EXPIRES_IN_S * 1000),
    intervalSeconds: BASE_INTERVAL_S,
    sourceIpHash: ipHash,
  });
  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${config.appUrl}/connect`,
    verification_uri_complete: `${config.appUrl}/connect?user_code=${userCode}`,
    expires_in: EXPIRES_IN_S,
    interval: BASE_INTERVAL_S,
  });
});

const rfcError = (c: import('hono').Context, code: string, status = 400) =>
  c.json({ error: code }, status as 400);

enrollRoutes.post('/api/device/token', async (c) => {
  const db = getDb(c);
  const config = getConfig(c);
  const now = new Date();
  const body = await c.req.json().catch(() => null);
  const v = validateBody<{ device_code: string }>(body, { device_code: isNonEmptyString(512) });
  if (!v.ok) return rfcError(c, 'invalid_request');

  const codeHash = hmac(config.machineKeyPepper, `dc:${v.value.device_code}`);
  const auth = await repo.findAuthByDeviceCode(db, codeHash);
  if (!auth) return rfcError(c, 'expired_token');
  if (auth.expiresAt.getTime() <= now.getTime()) {
    if (auth.status === 'pending') await repo.updateAuthorization(db, auth.id, { status: 'expired' });
    return rfcError(c, 'expired_token');
  }
  if (auth.status === 'denied' || auth.status === 'consumed') return rfcError(c, 'access_denied');
  if (auth.status === 'expired') return rfcError(c, 'expired_token');

  if (auth.status === 'pending') {
    // RFC 8628 poll throttling: too fast → slow_down and bump interval by 5s.
    if (
      auth.lastPolledAt &&
      now.getTime() - auth.lastPolledAt.getTime() < auth.intervalSeconds * 1000
    ) {
      await repo.updateAuthorization(db, auth.id, {
        intervalSeconds: auth.intervalSeconds + 5,
        lastPolledAt: now,
      });
      return rfcError(c, 'slow_down');
    }
    await repo.updateAuthorization(db, auth.id, { lastPolledAt: now });
    return rfcError(c, 'authorization_pending');
  }

  if (auth.status !== 'approved') return rfcError(c, 'access_denied');

  // Approved: redeem exactly once, in a transaction.
  const result = await db.transaction(async (tx) => {
    const t = repo.asDb(tx);
    const locked = await repo.lockAuthByDeviceCode(t, codeHash);
    if (!locked || locked.status !== 'approved') return { error: 'access_denied' as const };
    if ((await repo.countLiveMachines(t, locked.userId!)) >= MACHINE_LIMIT) {
      return { error: 'access_denied' as const };
    }
    const machineId = randomId('m');
    const secret = randomSecret(32);
    const key = `aw_${machineId}_${secret}`;
    await repo.insertMachine(t, {
      id: machineId,
      userId: locked.userId!,
      name: locked.clientName,
      os: locked.clientOs,
      keyHash: hmac(config.machineKeyPepper, `mk:${secret}`),
    });
    await repo.updateAuthorization(t, locked.id, { status: 'consumed' });
    return { machine_id: machineId, key };
  });
  if ('error' in result) return rfcError(c, result.error);
  log.info('machine enrolled', { machineId: result.machine_id });
  return c.json(result);
});

enrollRoutes.get('/api/device/pending', firebaseAuth, requireVerified, async (c) => {
  const code = c.req.query('user_code') ?? '';
  const normalized = normalizeUserCode(code);
  if (!normalized) return validationFailed(c, 'invalid user_code');
  const db = getDb(c);
  const config = getConfig(c);
  const auth = await repo.findAuthByUserCode(db, hmac(config.machineKeyPepper, `uc:${normalized}`));
  const now = new Date();
  if (!auth || auth.status !== 'pending' || auth.expiresAt.getTime() <= now.getTime()) {
    return notFound(c);
  }
  return c.json({
    user_code: formatUserCode(normalized),
    client_name: auth.clientName,
    client_os: auth.clientOs,
    requested_at: rfc3339(auth.createdAt),
    expires_at: rfc3339(auth.expiresAt),
  });
});

const reviewLimit = async (c: import('hono').Context<{ Variables: Vars }>, userId: string) => {
  const retry = await repo.hitRateLimit(getDb(c), `u:${userId}:device_review`, 3600, 30, new Date());
  return retry;
};

enrollRoutes.post('/api/device/approve', firebaseAuth, requireVerified, async (c) => {
  const p = getPrincipal(c);
  if (p.kind !== 'user') return unauthorized(c);
  const retry = await reviewLimit(c, p.userId);
  if (retry !== null) return rateLimited(c, retry);

  const body = await c.req.json().catch(() => null);
  const v = validateBody<{ user_code: string }>(body, { user_code: isNonEmptyString(16) });
  if (!v.ok) return validationFailed(c, v.reason);
  const normalized = normalizeUserCode(v.value.user_code);
  if (!normalized) return validationFailed(c, 'invalid user_code');

  const db = getDb(c);
  const config = getConfig(c);
  const deps = getDeps(c);
  const now = new Date();
  const codeHash = hmac(config.machineKeyPepper, `uc:${normalized}`);

  const outcome = await db.transaction(async (tx) => {
    const t = repo.asDb(tx);
    const auth = await repo.lockAuthByUserCode(t, codeHash);
    if (!auth || auth.status !== 'pending' || auth.expiresAt.getTime() <= now.getTime()) {
      return 'not_found' as const;
    }
    if ((await repo.countLiveMachines(t, p.userId)) >= MACHINE_LIMIT) {
      return 'limit' as const;
    }
    await repo.updateAuthorization(t, auth.id, { status: 'approved', userId: p.userId });
    await deps.jobs.enqueue(
      'machine_connected_email',
      { user_id: p.userId, client_name: auth.clientName, client_os: auth.clientOs },
      now,
      { dbOrTx: t, dedupeKey: `mc:${auth.id}` },
    );
    return 'ok' as const;
  });

  if (outcome === 'not_found') return notFound(c);
  if (outcome === 'limit') return limitReached(c);
  return c.json({ approved: true });
});

enrollRoutes.post('/api/device/deny', firebaseAuth, requireVerified, async (c) => {
  const p = getPrincipal(c);
  if (p.kind !== 'user') return unauthorized(c);
  const retry = await reviewLimit(c, p.userId);
  if (retry !== null) return rateLimited(c, retry);

  const body = await c.req.json().catch(() => null);
  const v = validateBody<{ user_code: string }>(body, { user_code: isNonEmptyString(16) });
  if (!v.ok) return validationFailed(c, v.reason);
  const normalized = normalizeUserCode(v.value.user_code);
  if (!normalized) return validationFailed(c, 'invalid user_code');

  const db = getDb(c);
  const config = getConfig(c);
  const now = new Date();
  const codeHash = hmac(config.machineKeyPepper, `uc:${normalized}`);
  const auth = await repo.findAuthByUserCode(db, codeHash);
  if (!auth || auth.status !== 'pending' || auth.expiresAt.getTime() <= now.getTime()) {
    return notFound(c);
  }
  await repo.updateAuthorization(db, auth.id, { status: 'denied', userId: p.userId });
  return c.json({ approved: false });
});
