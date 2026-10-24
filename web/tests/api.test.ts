import { describe, expect, it, vi } from 'vitest';
import { ApiError, createDeviceApi, createUserApi } from '../src/lib/api';
import { consoleOutput } from '../vitest.setup';

const BASE = 'https://api.example.test';
const TOKEN = 'test-id-token';
const SECRET = 'test-device-secret';

function fetchReturning(status: number, body: unknown = {}) {
  return vi.fn().mockImplementation(
    () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
  );
}

function lastCall(f: ReturnType<typeof vi.fn>) {
  const [url, init] = f.mock.calls[f.mock.calls.length - 1] as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

describe('api client', () => {
  it('sends X-AgentWatch-Protocol: 1 and Bearer auth on every user call', async () => {
    const f = fetchReturning(200, {});
    const getToken = vi.fn().mockResolvedValue(TOKEN);
    const api = createUserApi(BASE, getToken);
    // exercise every verb
    (globalThis as { fetch?: unknown }).fetch = f;
    await api.me();
    await api.setNotifications(true);
    await api.machines();
    await api.deleteMachine('m_1');
    await api.registerDevice('fcm');
    await api.deleteDevice('d_1');
    await api.pendingApproval('XKCD-9W2P');
    await api.approveDevice('XKCD-9W2P');
    await api.denyDevice('XKCD-9W2P');
    await api.deleteMe();

    expect(f).toHaveBeenCalledTimes(10);
    for (const call of f.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers['X-AgentWatch-Protocol']).toBe('1');
      expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
      expect(headers['Content-Type']).toBe('application/json');
    }
    expect(consoleOutput()).not.toContain(TOKEN);
  });

  it('sends Device auth and the protocol header on receipts and seen', async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const api = createDeviceApi(BASE, { deviceId: 'd_1', secret: SECRET }, f);
    await api.receipt('del_1');
    await api.seen();
    for (const call of f.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers['X-AgentWatch-Protocol']).toBe('1');
      expect(headers['Authorization']).toBe(`Device d_1.${SECRET}`);
    }
    expect(lastCall(f).url).toBe(`${BASE}/api/devices/seen`);
    expect(consoleOutput()).not.toContain(SECRET);
  });

  it('posts the right paths and bodies', async () => {
    const f = fetchReturning(200, { approved: true });
    (globalThis as { fetch?: unknown }).fetch = f;
    const api = createUserApi(BASE, () => Promise.resolve(TOKEN));
    await api.approveDevice('XKCD-9W2P');
    const { url, init } = lastCall(f);
    expect(url).toBe(`${BASE}/api/device/approve`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ user_code: 'XKCD-9W2P' });
  });

  it('turns error envelopes into ApiError with the spec code', async () => {
    const f = fetchReturning(403, { error: { code: 'email_not_verified', message: 'verify' } });
    (globalThis as { fetch?: unknown }).fetch = f;
    const api = createUserApi(BASE, () => Promise.resolve(TOKEN));
    await expect(api.me()).rejects.toMatchObject({ status: 403, code: 'email_not_verified' });
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
  });
});
