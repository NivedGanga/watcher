import { useCallback, useEffect, useState } from 'react';
import { ApiError, type Machine } from '../lib/api';
import { useApi } from '../lib/ApiContext';

function heartbeatLine(m: Machine): string {
  if (!m.last_heartbeat_at) return 'no heartbeat yet';
  const d = new Date(m.last_heartbeat_at);
  if (Number.isNaN(d.getTime())) return 'no heartbeat yet';
  return `last heartbeat ${d.toLocaleString()}`;
}

export function MachinesSection() {
  const api = useApi();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .machines()
      .then(setMachines)
      .catch((e) => setError(e instanceof ApiError ? e.code : 'network_error'));
  }, [api]);

  useEffect(load, [load]);

  const revoke = async (m: Machine) => {
    if (!window.confirm(`Revoke ${m.name}? Its key will stop working immediately.`)) return;
    setRevoking(m.id);
    setError(null);
    try {
      await api.deleteMachine(m.id);
      setMachines((prev) => (prev ?? []).filter((x) => x.id !== m.id));
    } catch (e) {
      setError(e instanceof ApiError ? e.code : 'network_error');
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section className="card" aria-label="Computers">
      <h2>Computers</h2>
      <p className="muted">
        To add a computer, install agentwatch on it and run <code>agentwatch login</code>.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {machines === null ? (
        <p className="muted">Loading…</p>
      ) : machines.length === 0 ? (
        <p className="muted">No computers connected.</p>
      ) : (
        <ul className="machines">
          {machines.map((m) => (
            <li key={m.id} className="row">
              <div>
                <strong>{m.name}</strong> <span className="muted">{m.os}</span>
                <div className="muted small">
                  {heartbeatLine(m)}
                  {m.active_runs > 0 ? ` · ${m.active_runs} active run${m.active_runs === 1 ? '' : 's'}` : ''}
                </div>
              </div>
              <button onClick={() => revoke(m)} disabled={revoking === m.id} className="danger">
                {revoking === m.id ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
