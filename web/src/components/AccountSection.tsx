import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useApi } from '../lib/ApiContext';
import { ApiError } from '../lib/api';
import { kvClear, getDeviceCredentials } from '../lib/kv';

// Sign out: revoke this browser's device, sign out of Firebase, clear local
// device credentials.
export async function signOutEverywhere(
  api: { deleteDevice(id: string): Promise<void> },
  signOut: () => Promise<void>,
): Promise<void> {
  const creds = await getDeviceCredentials();
  if (creds) {
    try {
      await api.deleteDevice(creds.device_id);
    } catch {
      // revoking is best-effort; local credentials are cleared regardless
    }
  }
  await signOut();
  await kvClear();
}

// Delete account: DELETE /api/me, delete the Firebase user, clear local state.
export async function deleteAccountEverywhere(
  api: { deleteMe(): Promise<void> },
  deleteFirebaseUser: () => Promise<void>,
): Promise<void> {
  await api.deleteMe();
  try {
    await deleteFirebaseUser();
  } catch {
    // The account is gone server-side; clear local state regardless. The
    // Firebase user may require recent sign-in — signing out still ends this
    // session.
  }
  await kvClear();
}

export function AccountSection() {
  const { user, signOut, deleteAccount } = useAuth();
  const api = useApi();
  const [busy, setBusy] = useState<'signout' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSignOut = async () => {
    setBusy('signout');
    setError(null);
    try {
      await signOutEverywhere(api, signOut);
    } catch (e) {
      setError(e instanceof ApiError ? e.code : 'network_error');
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async () => {
    if (
      !window.confirm(
        'Delete your AgentWatch account? All machines, devices, and events are removed immediately. This cannot be undone.',
      )
    )
      return;
    setBusy('delete');
    setError(null);
    try {
      await deleteAccountEverywhere(api, deleteAccount);
    } catch (e) {
      setError(e instanceof ApiError ? e.code : 'network_error');
      setBusy(null);
    }
  };

  return (
    <section className="card" aria-label="Account">
      <h2>Account</h2>
      <p>
        Signed in as <strong data-testid="account-email">{user?.email ?? 'unknown'}</strong>
      </p>
      <p className="muted small">
        Alerts go to the computer events sent by the agentwatch CLI signed in with this account. If
        this isn&apos;t the right account, sign out and sign in with the account used for the CLI.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="row gap">
        <button onClick={onSignOut} disabled={busy !== null}>
          {busy === 'signout' ? 'Signing out…' : 'Sign out'}
        </button>
        <button onClick={onDelete} disabled={busy !== null} className="danger">
          {busy === 'delete' ? 'Deleting…' : 'Delete account'}
        </button>
      </div>
    </section>
  );
}
