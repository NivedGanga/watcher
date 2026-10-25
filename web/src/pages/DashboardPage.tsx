import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAlerts } from '../lib/alerts';
import { useApi } from '../lib/ApiContext';
import {
  listenForeground,
  registerPushServiceWorker,
  seenPingOnceADay,
  pushSupport,
} from '../lib/push';
import type { AlertData } from '../shared/awsw';
import { NotificationsSection } from '../components/NotificationsSection';
import { BrowserCard } from '../components/BrowserCard';
import { RecentAlerts } from '../components/RecentAlerts';
import { MachinesSection } from '../components/MachinesSection';
import { AccountSection } from '../components/AccountSection';
import { InstallButton } from '../components/InstallButton';

export function DashboardPage() {
  const { add, seed } = useAlerts();
  const api = useApi();
  const [params] = useSearchParams();
  const openedAlert = params.get('alert');

  useEffect(() => {
    api.recentEvents(20).then((r) => seed(r.events)).catch(() => undefined);
  }, [api, seed]);

  useEffect(() => {
    if (pushSupport() === 'ok') {
      registerPushServiceWorker().catch(() => undefined);
      seenPingOnceADay().catch(() => undefined);
    }

    let unsubscribe: (() => void) | undefined;
    listenForeground({
      onAlert: (a: AlertData) => add(a),
      onState: (s) => {
        window.dispatchEvent(new CustomEvent('aw:flag-state', { detail: s }));
      },
    }).then((u) => {
      unsubscribe = u;
    });

    // Notification clicks from the service worker feed the session list.
    const onSwMessage = (e: MessageEvent) => {
      const data = e.data as { kind?: string; alert?: AlertData | null } | undefined;
      if (data?.kind === 'agentwatch-alert-click' && data.alert) add(data.alert);
    };
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', onSwMessage);
    }
    return () => {
      unsubscribe?.();
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', onSwMessage);
      }
    };
  }, [add]);

  return (
    <main className="page">
      <header className="row">
        <h1>AgentWatch</h1>
        <InstallButton />
      </header>
      {openedAlert && (
        <p className="card notice" role="status">
          Opened from notification — alert <code>{openedAlert}</code>. Full details are only kept for
          alerts received while this window is open.
        </p>
      )}
      <NotificationsSection />
      <BrowserCard />
      <RecentAlerts />
      <MachinesSection />
      <AccountSection />
      <footer className="muted small">
        <Link to="/privacy">Privacy</Link> · <Link to="/terms">Terms</Link>
      </footer>
    </main>
  );
}
