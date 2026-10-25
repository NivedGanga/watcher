import { useState } from 'react';
import { useAlerts } from '../lib/alerts';

const COLLAPSED_COUNT = 3;

function timeOf(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function RecentAlerts() {
  const { alerts, loaded } = useAlerts();
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? alerts : alerts.slice(0, COLLAPSED_COUNT);
  const hidden = alerts.length - visible.length;
  return (
    <section className="card" aria-label="Recent alerts" aria-busy={!loaded}>
      <h2>Recent alerts</h2>
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : alerts.length === 0 ? (
        <p className="muted">No recent alerts.</p>
      ) : (
        <>
          <ul className="alerts">
            {visible.map((a) => (
              <li key={a.event_id}>
                <span className={`badge type-${a.event_type}`}>{a.event_type}</span>{' '}
                <strong>{a.agent}</strong> <span className="muted">on {a.host}</span>
                <div className="summary">{a.summary}</div>
                <div className="muted small">{timeOf(a.timestamp)}</div>
              </li>
            ))}
          </ul>
          {hidden > 0 && (
            <button className="link" onClick={() => setShowAll(true)}>
              Show all ({alerts.length})
            </button>
          )}
          {showAll && alerts.length > COLLAPSED_COUNT && (
            <button className="link" onClick={() => setShowAll(false)}>
              Show less
            </button>
          )}
        </>
      )}
    </section>
  );
}
