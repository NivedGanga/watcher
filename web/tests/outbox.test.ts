import { beforeEach, describe, expect, it, vi } from 'vitest';
import { kvClear, kvGet, setDeviceCredentials, KEY_OUTBOX } from '../src/lib/kv';
import { drainOutbox, enqueueReceipt, sendReceipt } from '../src/shared/awsw';
import { consoleOutput } from '../vitest.setup';

const BASE = 'https://api.example.test';
const SECRET = 'outbox-secret';

const okFetch = () => vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
const failFetch = () => vi.fn().mockRejectedValue(new Error('offline'));

describe('receipt outbox', () => {
  beforeEach(async () => {
    await kvClear();
    await setDeviceCredentials({ device_id: 'd_1', device_secret: SECRET });
  });

  it('queues the delivery_id when the receipt fails', async () => {
    const sent = await sendReceipt(BASE, 'del_1', failFetch());
    expect(sent).toBe(false);
    expect(await kvGet<string[]>(KEY_OUTBOX)).toEqual(['del_1']);
    expect(consoleOutput()).not.toContain(SECRET);
  });

  it('retries a queued receipt and removes it on success', async () => {
    await enqueueReceipt('del_2');
    const f = okFetch();
    const remaining = await drainOutbox(BASE, f);
    expect(remaining).toBe(0);
    expect(await kvGet<string[]>(KEY_OUTBOX)).toEqual([]);
    expect(f).toHaveBeenCalledTimes(1);
    const headers = (f.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Device d_1.${SECRET}`);
    expect(headers['X-AgentWatch-Protocol']).toBe('1');
    expect(consoleOutput()).not.toContain(SECRET);
  });

  it('keeps the id queued when the retry fails and does not duplicate', async () => {
    await enqueueReceipt('del_3');
    await enqueueReceipt('del_3');
    expect(await kvGet<string[]>(KEY_OUTBOX)).toEqual(['del_3']);
    const remaining = await drainOutbox(BASE, failFetch());
    expect(remaining).toBe(1);
    expect(await kvGet<string[]>(KEY_OUTBOX)).toEqual(['del_3']);
  });

  it('leaves the outbox alone when there are no credentials', async () => {
    await kvClear();
    await enqueueReceipt('del_4');
    const remaining = await drainOutbox(BASE, okFetch());
    expect(remaining).toBe(1);
    expect(await kvGet<string[]>(KEY_OUTBOX)).toEqual(['del_4']);
  });
});
