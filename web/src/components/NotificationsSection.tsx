import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../lib/api';
import { useApi } from '../lib/ApiContext';

interface FlagState {
  on: boolean;
  until: string | null;
}

function errorCategory(e: unknown): string {
  if (e instanceof ApiError) return e.code;
  return 'network_error';
}

export function statusLine(state: FlagState | null): string {
  if (!state || !state.on || !state.until) return 'Alerts off';
  const until = new Date(state.until);
  if (Number.isNaN(until.getTime())) return 'Alerts off';
  const hhmm = until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `Alerts on until ${hhmm}`;
}

export function NotificationsSection() {
  const api = useApi();
  const [state, setState] = useState<FlagState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .me()
      .then((m) => {
        if (alive) setState({ on: m.notify_on_phone, until: m.until });
      })
      .catch((e) => {
        if (alive) setLoadError(errorCategory(e));
      });
    return () => {
      alive = false;
    };
  }, [api]);

  // Server-pushed flag state (foreground state messages).
  useEffect(() => {
    const onFlagState = (e: Event) => {
      const s = (e as CustomEvent<{ on: boolean; until: string | null }>).detail;
      setState({ on: s.on, until: s.until });
    };
    window.addEventListener('aw:flag-state', onFlagState);
    return () => window.removeEventListener('aw:flag-state', onFlagState);
  }, []);

  const toggle = useCallback(async () => {
    if (!state || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const r = await api.setNotifications(!state.on);
      // The switch always displays the server's returned value.
      setState({ on: r.notify_on_phone, until: r.until });
    } catch (e) {
      setSendError(errorCategory(e));
    } finally {
      setSending(false);
    }
  }, [api, state, sending]);

  return (
    <section className="card" aria-label="Phone alerts">
      <div className="row">
        <div>
          <h2>Phone alerts</h2>
          <p className="status" data-testid="alert-status">
            {loadError ? 'Alerts status unavailable' : statusLine(state)}
          </p>
        </div>
        <div className="switch-wrap">
          {sending && <span className="muted">Sending…</span>}
          <button
            role="switch"
            aria-checked={state?.on ?? false}
            aria-label="Phone alerts"
            disabled={!state || sending}
            onClick={toggle}
            className={state?.on ? 'switch on' : 'switch'}
          >
            <span className="knob" />
          </button>
        </div>
      </div>
      {loadError && (
        <p role="alert" className="error">
          Couldn&apos;t load alert state: {loadError}
        </p>
      )}
      {sendError && (
        <p role="alert" className="error">
          Couldn&apos;t update phone alerts: {sendError}
        </p>
      )}
    </section>
  );
}
