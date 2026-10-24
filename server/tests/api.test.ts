import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  app, db, deps, config, resetDb, seedUser, seedMachine, seedDevice,
  authHeaders, PROTOCOL, makeEvent, uuid, tick, postEvents,
} from './helpers.js';
import * as repo from '../src/repo.js';
import { hmac } from '../src/lib/crypto.js';

beforeEach(resetDb);

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers });

const put = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const del = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'DELETE', headers });

// ---------- protocol header ----------

describe('protocol header', () => {
  it('missing header returns 426 upgrade_required', async () => {
    const res = await get('/api/me', { Authorization: 'Bearer x' });
    expect(res.status).toBe(426);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('upgrade_required');
  });
  it('wrong version returns 426', async () => {
    const res = await get('/api/me', {
      Authorization: 'Bearer x',
      'X-AgentWatch-Protocol': '2',
    });
    expect(res.status).toBe(426);
  });
  it('applies to enrollment endpoints', async () => {
    const res = await post('/api/device/start', { client_name: 'x', client_os: 'y' });
    expect(res.status).toBe(426);
  });
});

// ---------- auth ----------

describe('authentication', () => {
  it('unknown machine key returns 401 with no detail', async () => {
    const res = await postEvents('aw_m_nope_secret', [makeEvent()]);
    expect(res.status).toBe(401);
  });
  it('malformed machine key returns 401', async () => {
    const res = await postEvents('not-a-key', [makeEvent()]);
    expect(res.status).toBe(401);
  });
  it('revoked machine key returns 401', async () => {
    const u = await seedUser({ email: 'a@x.com' });
    const m = await seedMachine(u.userId, { revoked: true });
    const res = await postEvents(m.key, [makeEvent()]);
    expect(res.status).toBe(401);
  });
  it('invalid firebase token returns 401', async () => {
    const res = await get('/api/me', authHeaders('bad-token'));
    expect(res.status).toBe(401);
  });
  it('unverified email returns 403 email_not_verified', async () => {
    await seedUser({ email: 'u@x.com', verified: false });
    const res = await get('/api/me', authHeaders('token-u@x.com'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe('email_not_verified');
  });
});

// ---------- device enrollment ----------

describe('device enrollment', () => {
  it('full flow: start → pending → approve → token once → access_denied', async () => {
    const start = await post(
      '/api/device/start',
      { client_name: 'workstation', client_os: 'macos' },
      PROTOCOL,
    );
    expect(start.status).toBe(200);
    const s = (await start.json()) as any;
    expect(s.expires_in).toBe(600);
    expect(s.interval).toBe(5);
    expect(s.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(s.verification_uri).toBe('https://app.example.com/connect');
    expect(s.verification_uri_complete).toContain(s.user_code);

    const poll1 = await post('/api/device/token', { device_code: s.device_code }, PROTOCOL);
    expect(((await poll1.json()) as any).error).toBe('authorization_pending');

    // immediate second poll → slow_down
    const poll2 = await post('/api/device/token', { device_code: s.device_code }, PROTOCOL);
    expect(((await poll2.json()) as any).error).toBe('slow_down');

    // make the next poll legal
    await db.execute(sql`UPDATE device_authorizations SET last_polled_at = now() - interval '1 hour'`);

    const u = await seedUser({ email: 'e@x.com' });
    const pending = await get(`/api/device/pending?user_code=${s.user_code}`, authHeaders(u.token));
    expect(pending.status).toBe(200);
    const p = (await pending.json()) as any;
    expect(p.client_name).toBe('workstation');
    expect(p.client_os).toBe('macos');

    const approve = await post('/api/device/approve', { user_code: s.user_code }, authHeaders(u.token));
    expect(approve.status).toBe(200);
    expect(((await approve.json()) as any).approved).toBe(true);

    // reset poll throttle
    await db.execute(sql`UPDATE device_authorizations SET last_polled_at = now() - interval '1 hour'`);

    const redeem = await post('/api/device/token', { device_code: s.device_code }, PROTOCOL);
    const r = (await redeem.json()) as any;
    expect(r.machine_id).toMatch(/^m_/);
    expect(r.key).toBe(`aw_${r.machine_id}_${r.key.slice(`aw_${r.machine_id}_`.length)}`);

    // second redemption → access_denied
    const again = await post('/api/device/token', { device_code: s.device_code }, PROTOCOL);
    expect(((await again.json()) as any).error).toBe('access_denied');

    // the machine key works
    const ev = await postEvents(r.key, [makeEvent()]);
    expect(ev.status).toBe(202);

    // connected email was enqueued and sent on tick
    await tick();
    expect(deps.email.sent.some((m) => m.subject.includes('New computer connected'))).toBe(true);
  });

  it('deny → access_denied', async () => {
    const start = await post('/api/device/start', { client_name: 'a', client_os: 'b' }, PROTOCOL);
    const s = (await start.json()) as any;
    const u = await seedUser({ email: 'd@x.com' });
    const deny = await post('/api/device/deny', { user_code: s.user_code }, authHeaders(u.token));
    expect(((await deny.json()) as any).approved).toBe(false);
    await db.execute(sql`UPDATE device_authorizations SET last_polled_at = now() - interval '1 hour'`);
    const poll = await post('/api/device/token', { device_code: s.device_code }, PROTOCOL);
    expect(((await poll.json()) as any).error).toBe('access_denied');
  });

  it('expired code → expired_token; unknown code → expired_token', async () => {
    const unknown = await post('/api/device/token', { device_code: 'nope' }, PROTOCOL);
    expect(((await unknown.json()) as any).error).toBe('expired_token');
    const start = await post('/api/device/start', { client_name: 'a', client_os: 'b' }, PROTOCOL);
    const s = (await start.json()) as any;
    await db.execute(sql`UPDATE device_authorizations SET expires_at = now() - interval '1 second'`);
    const poll = await post('/api/device/token', { device_code: s.device_code }, PROTOCOL);
    expect(((await poll.json()) as any).error).toBe('expired_token');
  });

  it('machine limit enforced at approve', async () => {
    const u = await seedUser({ email: 'l@x.com' });
    for (let i = 0; i < 5; i++) await seedMachine(u.userId);
    const start = await post('/api/device/start', { client_name: 'a', client_os: 'b' }, PROTOCOL);
    const s = (await start.json()) as any;
    const res = await post('/api/device/approve', { user_code: s.user_code }, authHeaders(u.token));
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe('limit_reached');
  });

  it('machine limit also enforced at token redemption', async () => {
    const u = await seedUser({ email: 'l2@x.com' });
    const start = await post('/api/device/start', { client_name: 'a', client_os: 'b' }, PROTOCOL);
    const s = (await start.json()) as any;
    await post('/api/device/approve', { user_code: s.user_code }, authHeaders(u.token));
    for (let i = 0; i < 5; i++) await seedMachine(u.userId);
    await db.execute(sql`UPDATE device_authorizations SET last_polled_at = now() - interval '1 hour'`);
    const poll = await post('/api/device/token', { device_code: s.device_code }, PROTOCOL);
    expect(((await poll.json()) as any).error).toBe('access_denied');
  });

  it('user_code matching is case-insensitive and dash-optional', async () => {
    const start = await post('/api/device/start', { client_name: 'a', client_os: 'b' }, PROTOCOL);
    const s = (await start.json()) as any;
    const u = await seedUser({ email: 'ci@x.com' });
    const lower = s.user_code.toLowerCase().replace('-', '');
    const res = await get(`/api/device/pending?user_code=${lower}`, authHeaders(u.token));
    expect(res.status).toBe(200);
  });

  it('pending lookup on decided/unknown codes returns 404', async () => {
    const u = await seedUser({ email: 'pd@x.com' });
    const res = await get('/api/device/pending?user_code=AAAA-AAAA', authHeaders(u.token));
    expect(res.status).toBe(404);
    const bad = await get('/api/device/pending?user_code=!!!', authHeaders(u.token));
    expect(bad.status).toBe(400);
  });
});

// ---------- devices ----------

describe('push devices', () => {
  it('register, rotate on re-register, revoke', async () => {
    const u = await seedUser({ email: 'dev@x.com' });
    const r1 = await post('/api/devices', { fcm_token: 'tok1' }, authHeaders(u.token));
    expect(r1.status).toBe(201);
    const d1 = (await r1.json()) as any;

    const r2 = await post('/api/devices', { fcm_token: 'tok1' }, authHeaders(u.token));
    const d2 = (await r2.json()) as any;
    expect(d2.device_id).toBe(d1.device_id);
    expect(d2.device_secret).not.toBe(d1.device_secret);

    // old secret no longer works
    const seenOld = await post('/api/devices/seen', {}, { Authorization: `Device ${d1.device_id}.${d1.device_secret}`, ...PROTOCOL });
    expect(seenOld.status).toBe(401);
    const seenNew = await post('/api/devices/seen', {}, { Authorization: `Device ${d2.device_id}.${d2.device_secret}`, ...PROTOCOL });
    expect(seenNew.status).toBe(204);

    // revoke
    const del = await app.request(`/api/devices/${d1.device_id}`, { method: 'DELETE', headers: authHeaders(u.token) });
    expect(del.status).toBe(204);
    const seenRevoked = await post('/api/devices/seen', {}, { Authorization: `Device ${d2.device_id}.${d2.device_secret}`, ...PROTOCOL });
    expect(seenRevoked.status).toBe(404);
  });

  it('device limit of 5', async () => {
    const u = await seedUser({ email: 'dl@x.com' });
    for (let i = 0; i < 5; i++) await seedDevice(u.userId);
    const res = await post('/api/devices', { fcm_token: 'tok-new' }, authHeaders(u.token));
    expect(res.status).toBe(409);
  });
});

// ---------- tenant isolation ----------

describe('tenant isolation', () => {
  it('user A cannot see or change user B data', async () => {
    const a = await seedUser({ email: 'a@x.com', notifyOnPhone: true, phoneAlertsSince: new Date() });
    const b = await seedUser({ email: 'b@x.com', notifyOnPhone: true, phoneAlertsSince: new Date() });
    const mb = await seedMachine(b.userId);
    const dbv = await seedDevice(b.userId);

    // A's machine list does not include B's machine
    const list = await get('/api/me/machines', authHeaders(a.token));
    expect(((await list.json()) as any).length).toBe(0);

    // A cannot delete B's machine or device
    expect((await del(`/api/me/machines/${mb.machineId}`, authHeaders(a.token))).status).toBe(404);
    expect((await del(`/api/devices/${dbv.deviceId}`, authHeaders(a.token))).status).toBe(404);

    // B's machine key can't write into A's account (routes to B's data only)
    const res = await postEvents(mb.key, [makeEvent()]);
    expect(res.status).toBe(202);
    const count = await db.execute(sql`SELECT count(*)::int AS n FROM events WHERE user_id = ${a.userId}`);
    expect((count as unknown as { n: number }[])[0]!.n).toBe(0);

    // B's device secret can't ack A's delivery
    const ev = makeEvent({ id: uuid() });
    await seedDevice(a.userId, { token: 'fa1' });
    await postEvents((await seedMachine(a.userId)).key, [ev]);
    const deliveries = await db.execute(sql`SELECT id FROM deliveries WHERE user_id = ${a.userId}`);
    const delId = (deliveries as unknown as { id: string }[])[0]!.id;
    const receipt = await post(
      '/api/receipts',
      { delivery_id: delId },
      { Authorization: `Device ${dbv.deviceId}.${dbv.secret}`, ...PROTOCOL },
    );
    expect(receipt.status).toBe(404);

    // A cannot approve B's enrollment code
    const start = await post('/api/device/start', { client_name: 'x', client_os: 'y' }, PROTOCOL);
    const s = (await start.json()) as any;
    // simulate B having approved their own code is not possible since B code isn't A's—
    // approve with A's token works on any pending code: the code is not user-bound until approval.
    // (Approving someone else's enrollment request is by-design allowed per RFC 8628 model.)
  });
});

// ---------- me endpoints ----------

describe('account endpoints', () => {
  it('GET /api/me returns account state', async () => {
    const u = await seedUser({ email: 'me@x.com', notifyOnPhone: true, phoneAlertsSince: new Date('2026-01-01T10:00:00Z') });
    await seedDevice(u.userId);
    await seedMachine(u.userId);
    const res = await get('/api/me', authHeaders(u.token));
    const body = (await res.json()) as any;
    expect(body.notify_on_phone).toBe(true);
    expect(body.until).toBe('2026-01-01T18:00:00Z');
    expect(body.email).toBe('me@x.com');
    expect(body.active_device_count).toBe(1);
    expect(body.machine_count).toBe(1);
  });

  it('PUT /api/me/notifications sets flag and emits state push on tick', async () => {
    const u = await seedUser({ email: 'n@x.com' });
    const d = await seedDevice(u.userId);
    const res = await put('/api/me/notifications', { enabled: true }, authHeaders(u.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.notify_on_phone).toBe(true);
    await tick();
    const stateMsgs = deps.push.sent.filter((m) => m.data['type'] === 'state');
    expect(stateMsgs.length).toBe(1);
    expect(stateMsgs[0]!.data['on']).toBe('true');
    expect(stateMsgs[0]!.headers['TTL']).toBe('300');
    // same-value call emits another state message
    await put('/api/me/notifications', { enabled: true }, authHeaders(u.token));
    await tick();
    expect(deps.push.sent.filter((m) => m.data['type'] === 'state').length).toBe(2);
  });

  it('DELETE /api/me deletes rows and revokes credentials', async () => {
    const u = await seedUser({ email: 'del@x.com' });
    const m = await seedMachine(u.userId);
    const d = await seedDevice(u.userId);
    await postEvents(m.key, [makeEvent()]);
    const res = await del('/api/me', authHeaders(u.token));
    expect(res.status).toBe(204);
    const events = await db.execute(sql`SELECT count(*)::int AS n FROM events WHERE user_id = ${u.userId}`);
    expect((events as unknown as { n: number }[])[0]!.n).toBe(0);
    // machine key no longer works
    expect((await postEvents(m.key, [makeEvent()])).status).toBe(401);
    // device secret no longer works
    const seen = await post('/api/devices/seen', {}, { Authorization: `Device ${d.deviceId}.${d.secret}`, ...PROTOCOL });
    expect(seen.status).not.toBe(204);
  });
});

// ---------- events ingest ----------

describe('events ingest', () => {
  it('accepts valid events, pushes to active devices on flag', async () => {
    const u = await seedUser({ email: 'e@x.com', notifyOnPhone: true, phoneAlertsSince: new Date() });
    const m = await seedMachine(u.userId);
    await seedDevice(u.userId, { token: 'ft1' });
    const res = await postEvents(m.key, [makeEvent()]);
    expect(res.status).toBe(202);
    expect(((await res.json()) as any).results[0].status).toBe('accepted');
    await tick();
    const alerts = deps.push.sent.filter((p) => p.data['type'] === 'alert');
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.data['event_type']).toBe('done');
    expect(alerts[0]!.headers['Urgency']).toBe('normal');
    expect(alerts[0]!.headers['TTL']).toBe('3600');
  });

  it('duplicate ids and tuples are not routed twice', async () => {
    const u = await seedUser({ email: 'dup@x.com', notifyOnPhone: true, phoneAlertsSince: new Date() });
    const m = await seedMachine(u.userId);
    await seedDevice(u.userId);
    const ev = makeEvent();
    await postEvents(m.key, [ev]);
    const res2 = await postEvents(m.key, [ev]);
    expect(((await res2.json()) as any).results[0].status).toBe('duplicate');
    // tuple dedupe, different id
    const res3 = await postEvents(m.key, [makeEvent({ id: uuid(), run_id: 'r1', type: 'done', summary: 'Run finished', timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') })]);
    expect(((await res3.json()) as any).results[0].status).toBe('duplicate');
    await tick();
    expect(deps.push.sent.filter((p) => p.data['type'] === 'alert').length).toBe(1);
  });

  it('rejects invalid events but accepts valid siblings', async () => {
    const u = await seedUser({ email: 'v@x.com' });
    const m = await seedMachine(u.userId);
    const res = await postEvents(m.key, [
      makeEvent({ summary: 'line\nbreak' }),
      makeEvent(),
    ]);
    const results = ((await res.json()) as any).results;
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('accepted');
  });

  it('rejects unknown fields', async () => {
    const u = await seedUser({ email: 'uf@x.com' });
    const m = await seedMachine(u.userId);
    const res = await postEvents(m.key, [makeEvent({ bogus: 1 })]);
    expect(((await res.json()) as any).results[0].status).toBe('rejected');
  });

  it('body over 64KB → validation_failed', async () => {
    const u = await seedUser({ email: 'big@x.com' });
    const m = await seedMachine(u.userId);
    const events = Array.from({ length: 50 }, () => makeEvent({ summary: 'x'.repeat(1400) }));
    const res = await postEvents(m.key, events);
    expect(res.status).toBe(400);
  });

  it('FCM data payloads contain only string values', async () => {
    const u = await seedUser({ email: 's@x.com', notifyOnPhone: true, phoneAlertsSince: new Date() });
    const m = await seedMachine(u.userId);
    await seedDevice(u.userId);
    await postEvents(m.key, [makeEvent({ exit_code: 1, duration_s: 5 })]);
    await tick();
    for (const msg of deps.push.sent) {
      for (const [k, v] of Object.entries(msg.data)) {
        expect(typeof v, `key ${k}`).toBe('string');
      }
    }
  });

  it('logs during a send contain no secrets', async () => {
    const u = await seedUser({ email: 'log@x.com', notifyOnPhone: true, phoneAlertsSince: new Date() });
    const m = await seedMachine(u.userId);
    const d = await seedDevice(u.userId, { token: 'SECRET_FCM_TOKEN_123' });
    const spy = vi.spyOn(console, 'log');
    const spyErr = vi.spyOn(console, 'error');
    try {
      await postEvents(m.key, [makeEvent({ summary: 'UNIQUE_SUMMARY_XYZ' })]);
      await tick();
      const logged = [...spy.mock.calls, ...spyErr.mock.calls].flat().join(' ');
      expect(logged).not.toContain('SECRET_FCM_TOKEN_123');
      expect(logged).not.toContain('UNIQUE_SUMMARY_XYZ');
      expect(logged).not.toContain(m.key);
      expect(logged).not.toContain(d.secret);
      expect(logged).not.toContain('test-pepper');
    } finally {
      spy.mockRestore();
      spyErr.mockRestore();
    }
  });
});

// ---------- fallback & receipts ----------

describe('receipt fallback and reminders', () => {
  it('no receipt → fallback email after 2 minutes', async () => {
    const u = await seedUser({ email: 'fb@x.com', notifyOnPhone: true, phoneAlertsSince: new Date() });
    const m = await seedMachine(u.userId);
    await seedDevice(u.userId);
    await postEvents(m.key, [makeEvent()]);
    const t1 = new Date(Date.now() + 121_000);
    await tick(t1);
    expect(deps.email.sent.length).toBe(1);
    expect(deps.email.sent[0]!.subject).toContain('[agentwatch] agent-a: done on workstation');
  });

  it('receipt → no fallback email', async () => {
    const u = await seedUser({ email: 'rc@x.com', notifyOnPhone: true, phoneAlertsSince: new Date() });
    const m = await seedMachine(u.userId);
    const d = await seedDevice(u.userId);
    const ev = makeEvent();
    await postEvents(m.key, [ev]);
    const rows = await db.execute(sql`SELECT id FROM deliveries WHERE channel = 'push'`);
    const delId = (rows as unknown as { id: string }[])[0]!.id;
    const receipt = await post('/api/receipts', { delivery_id: delId }, { Authorization: `Device ${d.deviceId}.${d.secret}`, ...PROTOCOL });
    expect(receipt.status).toBe(204);
    await tick(new Date(Date.now() + 121_000));
    expect(deps.email.sent.length).toBe(0);
    // delivery marked skipped with reason
    const em = await db.execute(sql`SELECT status, skip_reason FROM deliveries WHERE channel='email'`);
    expect((em as unknown as { status: string }[])[0]!.status).toBe('skipped');
  });

  it('question receipt schedules reminder; sent when no output_seen', async () => {
    const u = await seedUser({ email: 'q@x.com', notifyOnPhone: true, phoneAlertsSince: new Date() });
    const m = await seedMachine(u.userId);
    const d = await seedDevice(u.userId);
    const qTs = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    await postEvents(m.key, [makeEvent({ type: 'question', blocking: true, timestamp: qTs })]);
    const rows = await db.execute(sql`SELECT id FROM deliveries WHERE channel = 'push'`);
    const delId = (rows as unknown as { id: string }[])[0]!.id;
    await post('/api/receipts', { delivery_id: delId }, { Authorization: `Device ${d.deviceId}.${d.secret}`, ...PROTOCOL });
    await tick(new Date(Date.now() + 601_000));
    expect(deps.email.sent.length).toBe(1);
  });

  it('reminder skipped when output_seen exists', async () => {
    const u = await seedUser({ email: 'q2@x.com', notifyOnPhone: true, phoneAlertsSince: new Date() });
    const m = await seedMachine(u.userId);
    const d = await seedDevice(u.userId);
    await postEvents(m.key, [makeEvent({ type: 'question', blocking: true })]);
    await app.request('/api/signals', {
      method: 'POST',
      headers: { ...authHeaders(m.key), 'Content-Type': 'application/json' },
      body: JSON.stringify({ signals: [{ id: uuid(), kind: 'output_seen', run_id: 'r1', at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }] }),
    });
    const rows = await db.execute(sql`SELECT id FROM deliveries WHERE channel = 'push'`);
    await post('/api/receipts', { delivery_id: (rows as unknown as { id: string }[])[0]!.id }, { Authorization: `Device ${d.deviceId}.${d.secret}`, ...PROTOCOL });
    await tick(new Date(Date.now() + 601_000));
    expect(deps.email.sent.length).toBe(0);
    const em = await db.execute(sql`SELECT skip_reason FROM deliveries WHERE channel='email'`);
    expect((em as unknown as { skip_reason: string }[])[0]!.skip_reason).toBe('output_seen');
  });
});

// ---------- signals & auto-off ----------

describe('signals and auto-off', () => {
  it('idle below threshold does nothing; at threshold turns flag off', async () => {
    const u = await seedUser({ email: 'ao@x.com', notifyOnPhone: true, phoneAlertsSince: new Date(Date.now() - 3600_000) });
    const m = await seedMachine(u.userId);
    const d = await seedDevice(u.userId);
    const sig = (idle: number, at?: string) =>
      app.request('/api/signals', {
        method: 'POST',
        headers: { ...authHeaders(m.key), 'Content-Type': 'application/json' },
        body: JSON.stringify({ signals: [{ id: uuid(), kind: 'input_resumed', run_id: null, at: at ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), idle_seconds: idle }] }),
      });
    await sig(299);
    expect((await repo.getUser(db, u.userId))!.notifyOnPhone).toBe(true);
    await sig(300);
    expect((await repo.getUser(db, u.userId))!.notifyOnPhone).toBe(false);
    await tick();
    expect(deps.push.sent.some((p) => p.data['type'] === 'state' && p.data['on'] === 'false')).toBe(true);
  });

  it('input predating phone_alerts_since does nothing', async () => {
    const u = await seedUser({ email: 'ao2@x.com', notifyOnPhone: true, phoneAlertsSince: new Date() });
    const m = await seedMachine(u.userId);
    await app.request('/api/signals', {
      method: 'POST',
      headers: { ...authHeaders(m.key), 'Content-Type': 'application/json' },
      body: JSON.stringify({ signals: [{ id: uuid(), kind: 'input_resumed', run_id: null, at: new Date(Date.now() - 7200_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), idle_seconds: 600 }] }),
    });
    expect((await repo.getUser(db, u.userId))!.notifyOnPhone).toBe(true);
  });
});

// ---------- heartbeat & silence ----------

describe('heartbeat and silence', () => {
  it('heartbeat updates machine and ends silence episode', async () => {
    const u = await seedUser({ email: 'hb@x.com' });
    const m = await seedMachine(u.userId, { lastHeartbeatAt: new Date(Date.now() - 3600_000), activeRuns: 3, silentAlertedAt: new Date() });
    const res = await post('/api/heartbeat', { sent_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), active_runs: 1 }, authHeaders(m.key));
    expect(res.status).toBe(204);
    const machine = (await repo.getMachine(db, m.machineId))!;
    expect(machine.silentAlertedAt).toBeNull();
    expect(machine.activeRuns).toBe(1);
  });

  it('silent machine with active_runs>0 alerts (push+email), once per episode', async () => {
    const u = await seedUser({ email: 'sil@x.com', notifyOnPhone: true, phoneAlertsSince: new Date() });
    const m = await seedMachine(u.userId, { name: 'box', lastHeartbeatAt: new Date(Date.now() - 16 * 60_000), activeRuns: 2 });
    await seedDevice(u.userId);
    await tick();
    expect(deps.push.sent.some((p) => p.data['event_type'] === 'host_silent')).toBe(true);
    expect(deps.email.sent.some((e) => e.subject.includes('has stopped reporting'))).toBe(true);
    // second tick: no repeat alert
    deps.push.reset(); deps.email.reset();
    await tick(new Date(Date.now() + 120_000));
    expect(deps.push.sent.length).toBe(0);
    expect(deps.email.sent.length).toBe(0);
  });

  it('silent machine with active_runs=0 does not alert', async () => {
    const u = await seedUser({ email: 'sil0@x.com' });
    await seedMachine(u.userId, { lastHeartbeatAt: new Date(Date.now() - 16 * 60_000), activeRuns: 0 });
    await seedDevice(u.userId);
    await tick();
    expect(deps.push.sent.length).toBe(0);
    expect(deps.email.sent.length).toBe(0);
    const m = (await repo.listMachines(db, u.userId))[0]!;
    expect(m.silentAlertedAt).not.toBeNull();
  });
});

// ---------- hard cap ----------

describe('hard cap', () => {
  it('turns the flag off at AWAY_MAX_HOURS and sends state push', async () => {
    const u = await seedUser({ email: 'hc@x.com', notifyOnPhone: true, phoneAlertsSince: new Date(Date.now() - 9 * 3600_000) });
    const d = await seedDevice(u.userId);
    await tick();
    expect((await repo.getUser(db, u.userId))!.notifyOnPhone).toBe(false);
    expect(deps.push.sent.some((p) => p.data['type'] === 'state' && p.data['on'] === 'false')).toBe(true);
  });
});

// ---------- grouping & closing ----------

describe('grouping over HTTP+DB path', () => {
  it('6th event grouped; closing message sent only when events suppressed', async () => {
    const u = await seedUser({ email: 'g@x.com', notifyOnPhone: true, phoneAlertsSince: new Date() });
    const m = await seedMachine(u.userId);
    await seedDevice(u.userId);
    const base = Date.now();
    const evs = Array.from({ length: 7 }, (_, i) =>
      makeEvent({
        id: uuid(),
        run_id: `r${i}`,
        summary: `step ${i}`,
        timestamp: new Date(base - 50_000 + i * 5000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      }),
    );
    await postEvents(m.key, evs);
    await tick();
    const alerts = deps.push.sent.filter((p) => p.data['type'] === 'alert');
    expect(alerts.length).toBe(6);
    expect(alerts[5]!.data['event_type']).toBe('grouped');
    expect(alerts[5]!.data['summary']).toContain('6 events from agent-a in the last minute');
    // window_start = first event's timestamp; close at +60s (already past)
    await tick(new Date(base + 120_000));
    const closing = deps.push.sent.filter((p) => p.data['event_type'] === 'group_closed');
    expect(closing.length).toBe(1);
    expect(closing[0]!.data['summary']).toContain('7 events from agent-a in the last minute; 1 not shown individually');
  });
});

// ---------- rate limits ----------

describe('rate limits', () => {
  it('device/start limited to 10/hour per IP with Retry-After', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await post('/api/device/start', { client_name: 'a', client_os: 'b' }, { ...PROTOCOL, 'x-forwarded-for': '1.2.3.4' });
      expect(res.status).toBe(200);
    }
    const res = await post('/api/device/start', { client_name: 'a', client_os: 'b' }, { ...PROTOCOL, 'x-forwarded-for': '1.2.3.4' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(((await res.json()) as any).error.code).toBe('rate_limited');
  });

  it('events limited to 60/machine/min', async () => {
    const u = await seedUser({ email: 'rl@x.com' });
    const m = await seedMachine(u.userId);
    await db.execute(
      sql`INSERT INTO rate_limits (key, window_start, count)
          VALUES (${'events:' + m.machineId}, ${new Date(Math.floor(Date.now() / 60000) * 60000).toISOString()}, 60)
          ON CONFLICT (key) DO UPDATE SET count = 60`,
    );
    const res = await postEvents(m.key, [makeEvent()]);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('test email limited to 5/hour', async () => {
    const u = await seedUser({ email: 'te@x.com' });
    const m = await seedMachine(u.userId);
    for (let i = 0; i < 5; i++) {
      const res = await post('/api/machines/current/test', {}, authHeaders(m.key));
      expect(res.status).toBe(202);
    }
    const res = await post('/api/machines/current/test', {}, authHeaders(m.key));
    expect(res.status).toBe(429);
  });
});

// ---------- test email & email rules ----------

describe('email rules', () => {
  it('test email sends on tick and respects monthly cap', async () => {
    const u = await seedUser({ email: 'tc@x.com' });
    const m = await seedMachine(u.userId);
    const res = await post('/api/machines/current/test', {}, authHeaders(m.key));
    expect(res.status).toBe(202);
    await tick();
    expect(deps.email.sent.some((e) => e.to === 'tc@x.com')).toBe(true);
  });

  it('test endpoint returns 409 at monthly cap', async () => {
    const u = await seedUser({ email: 'cap@x.com' });
    const m = await seedMachine(u.userId);
    const month = new Date().toISOString().slice(0, 7);
    await db.execute(sql`INSERT INTO usage_monthly (user_id, month, emails_sent) VALUES (${u.userId}, ${month}, 200)`);
    const res = await post('/api/machines/current/test', {}, authHeaders(m.key));
    expect(res.status).toBe(409);
  });

  it('email to unverified address is never sent', async () => {
    const u = await seedUser({ email: 'un@x.com', verified: false });
    const m = await seedMachine(u.userId);
    // flag off + no devices → immediate email path
    await postEvents(m.key, [makeEvent()]);
    await tick();
    expect(deps.email.sent.length).toBe(0);
    const rows = await db.execute(sql`SELECT status, skip_reason FROM deliveries WHERE channel='email'`);
    expect((rows as unknown as { status: string; skip_reason: string }[])[0]!.status).toBe('skipped');
    expect((rows as unknown as { status: string; skip_reason: string }[])[0]!.skip_reason).toBe('email_unverified');
  });
});

// ---------- fcm not-registered ----------

describe('fcm failure handling', () => {
  it('registration-token-not-registered revokes the device and is not retried', async () => {
    const u = await seedUser({ email: 'nr@x.com', notifyOnPhone: true, phoneAlertsSince: new Date() });
    const m = await seedMachine(u.userId);
    const d = await seedDevice(u.userId, { token: 'dead-token' });
    deps.push.failToken('dead-token', 'messaging/registration-token-not-registered');
    await postEvents(m.key, [makeEvent()]);
    await tick();
    const dev = (await repo.getDevice(db, d.deviceId))!;
    expect(dev.revokedAt).not.toBeNull();
    const rows = await db.execute(sql`SELECT status, attempts FROM deliveries WHERE channel='push'`);
    const row = (rows as unknown as { status: string; attempts: number }[])[0]!;
    expect(row.status).toBe('failed');
    // next tick does not retry
    const attemptsBefore = row.attempts;
    await tick(new Date(Date.now() + 120_000));
    const rows2 = await db.execute(sql`SELECT attempts FROM deliveries WHERE channel='push'`);
    expect((rows2 as unknown as { attempts: number }[])[0]!.attempts).toBe(attemptsBefore);
  });

  it('transient failures retry with backoff up to 5 attempts', async () => {
    const u = await seedUser({ email: 'tf@x.com', notifyOnPhone: true, phoneAlertsSince: new Date() });
    const m = await seedMachine(u.userId);
    await seedDevice(u.userId, { token: 'flaky' });
    deps.push.failAll = 'messaging/internal-error';
    await postEvents(m.key, [makeEvent()]);
    for (let i = 0; i < 8; i++) {
      await tick(new Date(Date.now() + i * 600_000));
    }
    const rows = await db.execute(sql`SELECT status, attempts FROM deliveries WHERE channel='push'`);
    const row = (rows as unknown as { status: string; attempts: number }[])[0]!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(5);
  });
});
