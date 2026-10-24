import { describe, expect, it, vi } from 'vitest';
import {
  handlePushData,
  handleNotificationClick,
  notificationForAlert,
  type AlertData,
  type StateData,
} from '../src/shared/awsw';
import { kvDel, kvGet, kvSet, setDeviceCredentials, KEY_OUTBOX, KEY_STATE } from '../src/lib/kv';
import { consoleOutput } from '../vitest.setup';

const BASE = 'https://api.example.test';
const SECRET = 'sw-device-secret';

function alert(over: Partial<AlertData> = {}): AlertData {
  return {
    type: 'alert',
    event_id: 'ev_1',
    delivery_id: 'del_1',
    event_type: 'failed',
    agent: 'claude',
    host: 'workstation',
    summary: 'exit 1 after npm test',
    run_id: 'run_9',
    timestamp: '2026-01-01T10:00:00Z',
    ...over,
  };
}

function state(over: Partial<StateData> = {}): StateData {
  return { type: 'state', on: 'true', until: '2026-01-01T18:00:00Z', timestamp: '2026-01-01T10:00:00Z', ...over };
}

function ctx(over: Record<string, unknown> = {}) {
  return {
    apiBase: BASE,
    showNotification: vi.fn().mockResolvedValue(undefined),
    fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    ...over,
  } as const;
}

describe('alert notifications', () => {
  it.each([
    ['question', 'Question from claude', true],
    ['failed', 'Failed: claude', true],
    ['timed_out', 'Timed out: claude', true],
    ['done', 'Finished: claude', false],
    ['stalled', 'Stalled: claude', false],
    ['host_silent', 'Host offline: workstation', true],
  ] as const)('%s shows "%s" (requireInteraction=%s)', async (event_type, title, ri) => {
    const c = ctx();
    await handlePushData(alert({ event_type }), c);
    expect(c.showNotification).toHaveBeenCalledWith(
      title,
      expect.objectContaining({ body: 'exit 1 after npm test', tag: 'run_9', requireInteraction: ri }),
    );
  });

  it('grouped titles use the count and agent', () => {
    const n = notificationForAlert(
      alert({ event_type: 'grouped', summary: '6 events from claude in the last minute' }),
    );
    expect(n.title).toBe('6 events from claude');
  });

  it('group_closed titles include the suppressed count', () => {
    const n = notificationForAlert(
      alert({
        event_type: 'group_closed',
        summary: '9 events from claude in the last minute; 3 not shown individually',
      }),
    );
    expect(n.title).toBe('9 events from claude; 3 not shown');
  });

  it('sends a receipt with device auth for every alert', async () => {
    await setDeviceCredentials({ device_id: 'd_9', device_secret: SECRET });
    const c = ctx();
    await handlePushData(alert({ delivery_id: 'del_77' }), c);
    const [url, init] = c.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/receipts`);
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Device d_9.${SECRET}`);
    expect(headers['X-AgentWatch-Protocol']).toBe('1');
    expect(JSON.parse(init.body as string)).toEqual({ delivery_id: 'del_77' });
    expect(consoleOutput()).not.toContain(SECRET);
  });

  it('queues the receipt when the request fails', async () => {
    const c = ctx({ fetchImpl: vi.fn().mockRejectedValue(new Error('down')) });
    await handlePushData(alert({ delivery_id: 'del_fail' }), c);
    expect(c.showNotification).toHaveBeenCalled(); // notification still shown
    expect(await kvGet<string[]>(KEY_OUTBOX)).toContain('del_fail');
    await kvSet(KEY_OUTBOX, []);
  });
});

describe('state messages', () => {
  it('never shows a notification and stores newer state', async () => {
    const c = ctx();
    await kvDel(KEY_STATE);
    const r = await handlePushData(state(), c);
    expect(c.showNotification).not.toHaveBeenCalled();
    expect(r.notified).toBe(false);
    expect(await kvGet(KEY_STATE)).toEqual({
      on: true,
      until: '2026-01-01T18:00:00Z',
      timestamp: '2026-01-01T10:00:00Z',
    });
  });
});

describe('notification click', () => {
  const data = alert({ event_id: 'ev_click' });

  it('opens /?alert=<event_id> when no window is open', async () => {
    const clients = {
      matchAll: vi.fn().mockResolvedValue([]),
      openWindow: vi.fn().mockResolvedValue(undefined),
    };
    await handleNotificationClick(data, clients);
    expect(clients.openWindow).toHaveBeenCalledWith(`/?alert=${encodeURIComponent('ev_click')}`);
  });

  it('focuses an open window and posts the event', async () => {
    const client = {
      url: 'http://localhost/',
      focus: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn(),
    };
    const clients = {
      matchAll: vi.fn().mockResolvedValue([client]),
      openWindow: vi.fn(),
    };
    await handleNotificationClick(data, clients);
    expect(client.focus).toHaveBeenCalled();
    expect(client.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'agentwatch-alert-click', event_id: 'ev_click' }),
    );
    expect(clients.openWindow).not.toHaveBeenCalled();
  });
});
