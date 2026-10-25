import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { AlertData } from '../shared/awsw';

export interface AlertItem {
  event_id: string;
  event_type: string;
  agent: string;
  host: string;
  summary: string;
  run_id: string;
  timestamp: string;
}

const MAX_RECENT = 50;

export interface AlertsState {
  alerts: AlertItem[];
  /** True once the initial server fetch has settled (success or failure). */
  loaded: boolean;
  add(alert: AlertItem): void;
  seed(items: AlertItem[]): void;
}

const AlertsContext = createContext<AlertsState>({
  alerts: [],
  loaded: false,
  add: () => undefined,
  seed: () => undefined,
});

export function useAlerts(): AlertsState {
  return useContext(AlertsContext);
}

export function toAlertItem(d: AlertData): AlertItem {
  return {
    event_id: d.event_id,
    event_type: d.event_type,
    agent: d.agent,
    host: d.host,
    summary: d.summary,
    run_id: d.run_id,
    timestamp: d.timestamp,
  };
}

// In-memory recent-alerts store: last 20, seeded from server history on
// load and fed live by foreground messages and notification clicks.
export function AlertsProvider({ children }: { children: ReactNode }) {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const add = useCallback((d: AlertItem) => {
    setAlerts((prev) => {
      const rest = prev.filter((a) => a.event_id !== d.event_id);
      return [d, ...rest].slice(0, MAX_RECENT);
    });
  }, []);
  const seed = useCallback((items: AlertItem[]) => {
    setLoaded(true);
    setAlerts((prev) => {
      const seen = new Set<string>();
      return [...items, ...prev]
        .filter((a) => (seen.has(a.event_id) ? false : (seen.add(a.event_id), true)))
        .slice(0, MAX_RECENT);
    });
  }, []);
  return (
    <AlertsContext.Provider value={{ alerts, loaded, add, seed }}>
      {children}
    </AlertsContext.Provider>
  );
}
