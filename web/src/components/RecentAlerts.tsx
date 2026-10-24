import { useAlerts } from '../lib/alerts';

function timeOf(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function RecentAlerts() {
  const { alerts } = useAlerts();
  return (
    <section className="card" aria-label="Recent alerts">
      <h2>Recent alerts</h2>
      {alerts.length === 0 ? (
        <p className="muted">No alerts yet this session.</p>
      ) : (
        <ul className="alerts">
          {alerts.map((a) => (
            <li key={a.event_id}>
              <span className={`badge type-${a.event_type}`}>{a.event_type}</span>{' '}
              <strong>{a.agent}</strong> <span className="muted">on {a.host}</span>
              <div className="summary">{a.summary}</div>
              <div className="muted small">{timeOf(a.timestamp)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
