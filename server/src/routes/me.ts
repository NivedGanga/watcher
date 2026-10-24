import { Hono } from 'hono';
import type { Vars } from '../middleware/auth.js';
import { firebaseAuth, requireVerified, getConfig, getDb, getDeps, getPrincipal } from '../middleware/auth.js';
import { validationFailed, notFound, limitReached, unauthorized } from '../lib/errors.js';
import { validateBody, isBoolean, isNonEmptyString } from '../lib/validate.js';
import { rfc3339, DEVICE_LIMIT } from '../lib/time.js';
import * as repo from '../repo.js';
import { aesGcmEncrypt, hmac, randomId, randomSecret } from '../lib/crypto.js';

export const meRoutes = new Hono<{ Variables: Vars }>();

const until = (user: repo.UserRow, awayMaxHours: number): string | null =>
  user.notifyOnPhone && user.phoneAlertsSince
    ? rfc3339(new Date(user.phoneAlertsSince.getTime() + awayMaxHours * 3_600_000))
    : null;

meRoutes.get('/api/me', firebaseAuth, requireVerified, async (c) => {
  const p = getPrincipal(c);
  if (p.kind !== 'user') return unauthorized(c);
  const db = getDb(c);
  const config = getConfig(c);
  const user = (await repo.getUser(db, p.userId))!;
  const now = new Date();
  const [devices, machines] = await Promise.all([
    repo.listActiveDevices(db, p.userId, now),
    repo.listMachines(db, p.userId),
  ]);
  return c.json({
    notify_on_phone: user.notifyOnPhone,
    phone_alerts_since: user.phoneAlertsSince ? rfc3339(user.phoneAlertsSince) : null,
    until: until(user, config.awayMaxHours),
    email: user.email,
    active_device_count: devices.length,
    machine_count: machines.length,
  });
});

meRoutes.put('/api/me/notifications', firebaseAuth, requireVerified, async (c) => {
  const p = getPrincipal(c);
  if (p.kind !== 'user') return unauthorized(c);
  const body = await c.req.json().catch(() => null);
  const v = validateBody<{ enabled: boolean }>(body, { enabled: isBoolean });
  if (!v.ok) return validationFailed(c, v.reason);
  const db = getDb(c);
  const deps = getDeps(c);
  const config = getConfig(c);
  const now = new Date();
  await db.transaction(async (tx) => {
    const t = repo.asDb(tx);
    await repo.lockUser(t, p.userId);
    await repo.setNotifyFlag(t, p.userId, v.value.enabled, now);
  });
  // Every call — including same-value — emits a state message to active devices.
  await deps.jobs.enqueue('state_push', { user_id: p.userId }, now, {
    dedupeKey: `sp:${p.userId}:${now.getTime()}`,
  });
  const user = (await repo.getUser(db, p.userId))!;
  return c.json({
    notify_on_phone: user.notifyOnPhone,
    phone_alerts_since: user.phoneAlertsSince ? rfc3339(user.phoneAlertsSince) : null,
    until: until(user, config.awayMaxHours),
  });
});

meRoutes.delete('/api/me', firebaseAuth, requireVerified, async (c) => {
  const p = getPrincipal(c);
  if (p.kind !== 'user') return unauthorized(c);
  const db = getDb(c);
  await db.transaction(async (tx) => {
    await repo.deleteAccount(repo.asDb(tx), p.userId);
  });
  return c.body(null, 204);
});

meRoutes.get('/api/me/machines', firebaseAuth, requireVerified, async (c) => {
  const p = getPrincipal(c);
  if (p.kind !== 'user') return unauthorized(c);
  const machines = await repo.listMachines(getDb(c), p.userId);
  return c.json(
    machines.map((m) => ({
      id: m.id,
      name: m.name,
      os: m.os,
      last_heartbeat_at: m.lastHeartbeatAt ? rfc3339(m.lastHeartbeatAt) : null,
      active_runs: m.activeRuns,
    })),
  );
});

meRoutes.delete('/api/me/machines/:id', firebaseAuth, requireVerified, async (c) => {
  const p = getPrincipal(c);
  if (p.kind !== 'user') return unauthorized(c);
  const ok = await repo.revokeMachine(getDb(c), p.userId, c.req.param('id'), new Date());
  if (!ok) return notFound(c);
  return c.body(null, 204);
});

meRoutes.post('/api/devices', firebaseAuth, requireVerified, async (c) => {
  const p = getPrincipal(c);
  if (p.kind !== 'user') return unauthorized(c);
  const body = await c.req.json().catch(() => null);
  const v = validateBody<{ fcm_token: string }>(body, { fcm_token: isNonEmptyString(4096) });
  if (!v.ok) return validationFailed(c, v.reason);
  const db = getDb(c);
  const config = getConfig(c);
  const now = new Date();
  const tokenHash = hmac(config.machineKeyPepper, `fcm:${v.value.fcm_token}`);
  const tokenEnc = aesGcmEncrypt(config.deviceTokenEncKey, v.value.fcm_token);

  const existing = await repo.findDeviceByTokenHash(db, p.userId, tokenHash);
  const secret = randomSecret(32);
  const secretHash = hmac(config.machineKeyPepper, `devsecret:${secret}`);
  if (existing) {
    // Re-registration rotates the secret; the same device_id is kept and the
    // previous secret stops working immediately.
    await repo.rotateDeviceSecret(db, existing.id, secretHash, now);
    return c.json({ device_id: existing.id, device_secret: secret }, 201);
  }
  if ((await repo.countLiveDevices(db, p.userId)) >= DEVICE_LIMIT) {
    return limitReached(c);
  }
  const id = randomId('d');
  await repo.insertDevice(db, {
    id,
    userId: p.userId,
    fcmTokenEnc: tokenEnc,
    fcmTokenHash: tokenHash,
    deviceSecretHash: secretHash,
  });
  return c.json({ device_id: id, device_secret: secret }, 201);
});

meRoutes.delete('/api/devices/:id', firebaseAuth, requireVerified, async (c) => {
  const p = getPrincipal(c);
  if (p.kind !== 'user') return unauthorized(c);
  const ok = await repo.revokeDevice(getDb(c), p.userId, c.req.param('id'), new Date());
  if (!ok) return notFound(c);
  return c.body(null, 204);
});
