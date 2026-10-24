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

const MAX_RECENT = 20;

export interface AlertsState {
  alerts: AlertItem[];
  add(alert: AlertData): void;
}

const AlertsContext = createContext<AlertsState>({ alerts: [], add: () => undefined });

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

// In-memory recent-alerts store: last 20 from this session only, fed by
// foreground messages and notification clicks.
export function AlertsProvider({ children }: { children: ReactNode }) {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const add = useCallback((d: AlertData) => {
    setAlerts((prev) => {
      const item = toAlertItem(d);
      const rest = prev.filter((a) => a.event_id !== item.event_id);
      return [item, ...rest].slice(0, MAX_RECENT);
    });
  }, []);
  return <AlertsContext.Provider value={{ alerts, add }}>{children}</AlertsContext.Provider>;
}
