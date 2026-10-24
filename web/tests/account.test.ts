import { describe, expect, it, vi } from 'vitest';
import { deleteAccountEverywhere, signOutEverywhere } from '../src/components/AccountSection';
import { getDeviceCredentials, kvGet, kvSet, setDeviceCredentials } from '../src/lib/kv';
import { consoleOutput } from '../vitest.setup';

const SECRET = 'account-device-secret';

describe('sign out', () => {
  it('deletes this browser device, signs out, and clears stored credentials', async () => {
    await setDeviceCredentials({ device_id: 'd_1', device_secret: SECRET });
    await kvSet('seen_ping_at', 123);
    const api = { deleteDevice: vi.fn().mockResolvedValue(undefined) };
    const signOut = vi.fn().mockResolvedValue(undefined);

    await signOutEverywhere(api, signOut);

    expect(api.deleteDevice).toHaveBeenCalledWith('d_1');
    expect(signOut).toHaveBeenCalled();
    expect(await getDeviceCredentials()).toBeUndefined();
    expect(await kvGet('seen_ping_at')).toBeUndefined();
    expect(consoleOutput()).not.toContain(SECRET);
  });

  it('still signs out when there is no registered device', async () => {
    const api = { deleteDevice: vi.fn() };
    const signOut = vi.fn().mockResolvedValue(undefined);
    await signOutEverywhere(api, signOut);
    expect(api.deleteDevice).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalled();
  });
});

describe('delete account', () => {
  it('calls DELETE /api/me, deletes the Firebase user, and clears local state', async () => {
    await setDeviceCredentials({ device_id: 'd_2', device_secret: SECRET });
    const api = { deleteMe: vi.fn().mockResolvedValue(undefined) };
    const deleteFirebaseUser = vi.fn().mockResolvedValue(undefined);

    await deleteAccountEverywhere(api, deleteFirebaseUser);

    expect(api.deleteMe).toHaveBeenCalled();
    expect(deleteFirebaseUser).toHaveBeenCalled();
    expect(await getDeviceCredentials()).toBeUndefined();
    expect(consoleOutput()).not.toContain(SECRET);
  });
});
