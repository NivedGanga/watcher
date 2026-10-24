import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';

export function SignIn() {
  const { signIn, error } = useAuth();
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const onSignIn = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      await signIn();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="center">
      <section className="card signin">
        <h1>AgentWatch</h1>
        <p>Alerts from your autonomous agents, on your phone.</p>
        <button onClick={onSignIn} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in with Google'}
        </button>
        {(error ?? localError) && <p role="alert" className="error">{error ?? localError}</p>}
        <p className="muted small">
          Sign in with the same Google account you use for the agentwatch CLI.
        </p>
      </section>
    </main>
  );
}
