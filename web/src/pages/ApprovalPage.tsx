import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useApi } from '../lib/ApiContext';
import { ApiError, type PendingDevice } from '../lib/api';
import { formatUserCode, normalizeUserCode } from '../lib/usercode';
import { SignIn } from '../components/SignIn';

type Stage =
  | { kind: 'entry' }
  | { kind: 'loading' }
  | { kind: 'found'; pending: PendingDevice }
  | { kind: 'not-found' }
  | { kind: 'approved' }
  | { kind: 'denied' }
  | { kind: 'error'; message: string };

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function ApprovalPage() {
  const { user, loading } = useAuth();
  const api = useApi();
  const [params] = useSearchParams();
  const [code, setCode] = useState(() => formatUserCode(params.get('user_code') ?? ''));
  const [stage, setStage] = useState<Stage>({ kind: 'entry' });
  const [acting, setActing] = useState(false);

  const normalized = normalizeUserCode(code);
  // Codes are sent to the API in the canonical XXXX-XXXX form.
  const apiCode = normalized.length === 8 ? formatUserCode(normalized) : normalized;

  const lookup = useCallback(
    async (rawCode: string) => {
      const c = normalizeUserCode(rawCode);
      if (!c) return;
      const wire = c.length === 8 ? formatUserCode(c) : c;
      setStage({ kind: 'loading' });
      try {
        const pending = await api.pendingApproval(wire);
        setStage({ kind: 'found', pending });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          setStage({ kind: 'not-found' });
        } else if (e instanceof ApiError && e.status === 400) {
          setStage({ kind: 'error', message: 'That is not a valid code. Codes look like XXXX-XXXX.' });
        } else {
          setStage({ kind: 'error', message: e instanceof ApiError ? e.code : 'network_error' });
        }
      }
    },
    [api],
  );

  // Auto-lookup when a signed-in user arrives with a complete code.
  useEffect(() => {
    if (user && normalized.length === 8 && stage.kind === 'entry') {
      lookup(normalized);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const decide = async (approve: boolean) => {
    setActing(true);
    try {
      if (approve) {
        await api.approveDevice(apiCode);
        setStage({ kind: 'approved' });
      } else {
        await api.denyDevice(apiCode);
        setStage({ kind: 'denied' });
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setStage({ kind: 'not-found' });
      } else {
        setStage({ kind: 'error', message: e instanceof ApiError ? e.code : 'network_error' });
      }
    } finally {
      setActing(false);
    }
  };

  if (loading) {
    return (
      <main className="center">
        <p>Loading…</p>
      </main>
    );
  }
  if (!user) {
    return <SignIn />;
  }

  return (
    <main className="center">
      <section className="card approve">
        <h1>Connect a computer</h1>
        <p className="muted">
          Signed in as <strong>{user.email ?? 'unknown'}</strong>
        </p>

        {stage.kind === 'entry' || stage.kind === 'loading' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              lookup(code);
            }}
          >
            <label htmlFor="user-code">Code shown by the CLI</label>
            <input
              id="user-code"
              value={code}
              onChange={(e) => setCode(formatUserCode(e.target.value))}
              placeholder="XXXX-XXXX"
              autoComplete="off"
              inputMode="text"
              maxLength={9}
            />
            <button type="submit" disabled={normalized.length !== 8 || stage.kind === 'loading'}>
              {stage.kind === 'loading' ? 'Looking up…' : 'Look up'}
            </button>
          </form>
        ) : null}

        {stage.kind === 'found' && (
          <div>
            <dl className="pending">
              <dt>Computer</dt>
              <dd>{stage.pending.client_name}</dd>
              <dt>OS</dt>
              <dd>{stage.pending.client_os}</dd>
              <dt>Code expires</dt>
              <dd>{fmtTime(stage.pending.expires_at)}</dd>
            </dl>
            <p className="warning" role="alert">
              Only approve if you just ran <code>agentwatch login</code> on this computer.
            </p>
            <div className="row gap">
              <button onClick={() => decide(true)} disabled={acting}>
                {acting ? 'Working…' : 'Approve'}
              </button>
              <button onClick={() => decide(false)} disabled={acting} className="danger">
                Deny
              </button>
            </div>
          </div>
        )}

        {stage.kind === 'approved' && (
          <p role="status" className="ok">
            Computer connected. You can close this page.
          </p>
        )}
        {stage.kind === 'denied' && (
          <p role="status">Denied. The computer was not connected.</p>
        )}
        {stage.kind === 'not-found' && (
          <p role="alert" className="error">
            This code wasn&apos;t found — it has expired or was already used. Run{' '}
            <code>agentwatch login</code> again for a new code.
          </p>
        )}
        {stage.kind === 'error' && (
          <p role="alert" className="error">
            {stage.message}
          </p>
        )}

        <p className="muted small">
          <Link to="/">Back to dashboard</Link>
        </p>
      </section>
    </main>
  );
}
