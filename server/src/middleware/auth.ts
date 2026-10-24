import { createMiddleware } from 'hono/factory';
import type { Context, Next } from 'hono';
import { upgradeRequired, unauthorized, notFound, emailNotVerified } from '../lib/errors.js';
import { hmac, hmacEqual } from '../lib/crypto.js';
import * as repo from '../repo.js';
import type { Config } from '../config.js';
import type { Deps } from '../providers/types.js';
import type { Db } from '../db/client.js';

export type Principal =
  | { kind: 'user'; userId: string; email: string; emailVerified: boolean }
  | { kind: 'machine'; machineId: string; userId: string; machine: repo.MachineRow }
  | { kind: 'device'; deviceId: string; userId: string; device: repo.DeviceRow }
  | { kind: 'cron' };

export interface Vars {
  config: Config;
  deps: Deps;
  db: Db;
  principal: Principal;
}

export const getDb = (c: Context<{ Variables: Vars }>) => c.get('db');
export const getDeps = (c: Context<{ Variables: Vars }>) => c.get('deps');
export const getConfig = (c: Context<{ Variables: Vars }>) => c.get('config');
export const getPrincipal = (c: Context<{ Variables: Vars }>) => c.get('principal');

/** X-AgentWatch-Protocol: 1 on every request (except the Vercel-cron GET tick). */
export const protocol = createMiddleware<{ Variables: Vars }>(async (c, next) => {
  if (c.req.method === 'OPTIONS') return next();
  if (c.req.path === '/api/jobs/tick' && c.req.method === 'GET') return next();
  if (c.req.header('x-agentwatch-protocol') !== '1') {
    return upgradeRequired(c);
  }
  return next();
});

const bearer = (c: Context): string | null => {
  const h = c.req.header('authorization');
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim();
};

/** Firebase ID token → upserted user. */
export const firebaseAuth = createMiddleware<{ Variables: Vars }>(async (c, next) => {
  const token = bearer(c);
  if (!token || token.startsWith('aw_')) return unauthorized(c);
  const verified = await getDeps(c).auth.verifyIdToken(token);
  if (!verified) return unauthorized(c);
  const user = await repo.upsertUserFromToken(getDb(c), {
    firebaseUid: verified.uid,
    email: verified.email,
    emailVerified: verified.emailVerified,
  });
  if (user.deletedAt) return unauthorized(c);
  c.set('principal', {
    kind: 'user',
    userId: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
  });
  return next();
});

export const requireVerified = createMiddleware<{ Variables: Vars }>(async (c, next) => {
  const p = getPrincipal(c);
  if (p.kind !== 'user') return unauthorized(c);
  if (!p.emailVerified) return emailNotVerified(c);
  return next();
});

const AW_KEY = /^aw_(.+)_(.+)$/;

export const machineAuth = createMiddleware<{ Variables: Vars }>(async (c, next) => {
  const token = bearer(c);
  if (!token) return unauthorized(c);
  const m = AW_KEY.exec(token);
  if (!m) return unauthorized(c);
  const [, machineId, secret] = m;
  const machine = await repo.getMachine(getDb(c), machineId!);
  if (!machine || machine.revokedAt) return unauthorized(c);
  const pepper = getConfig(c).machineKeyPepper;
  if (!hmacEqual(hmac(pepper, `mk:${secret!}`), machine.keyHash)) return unauthorized(c);
  c.set('principal', { kind: 'machine', machineId: machine.id, userId: machine.userId, machine });
  return next();
});

export const deviceAuth = createMiddleware<{ Variables: Vars }>(async (c, next) => {
  const h = c.req.header('authorization');
  if (!h || !h.startsWith('Device ')) return unauthorized(c);
  const cred = h.slice('Device '.length).trim();
  const dot = cred.indexOf('.');
  if (dot <= 0) return unauthorized(c);
  const deviceId = cred.slice(0, dot);
  const secret = cred.slice(dot + 1);
  const device = await repo.getDevice(getDb(c), deviceId);
  if (!device) return unauthorized(c);
  const pepper = getConfig(c).machineKeyPepper;
  if (!hmacEqual(hmac(pepper, `devsecret:${secret}`), device.deviceSecretHash)) return unauthorized(c);
  if (device.revokedAt) return notFound(c);
  c.set('principal', { kind: 'device', deviceId: device.id, userId: device.userId, device });
  return next();
});

export const cronAuth = createMiddleware<{ Variables: Vars }>(async (c, next) => {
  const token = bearer(c);
  if (!token) return unauthorized(c);
  if (!hmacEqual(token, getConfig(c).cronSecret)) return unauthorized(c);
  c.set('principal', { kind: 'cron' });
  return next();
});
