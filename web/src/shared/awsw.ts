// AgentWatch push-handling logic, shared between the service worker and the
// page. scripts/build-sw.mjs bundles this file into public/awsw.js (an IIFE
// exposing `AgentWatchSW`) which /firebase-messaging-sw.js loads with
// importScripts. The page imports the same functions directly.
//
// Never log payload contents, delivery ids, or credentials.

import { getDeviceCredentials, kvGet, kvSet, KEY_OUTBOX, KEY_STATE } from '../lib/kv';
import { createDeviceApi, type FetchLike } from '../lib/api';

export type EventType =
  | 'question'
  | 'failed'
  | 'timed_out'
  | 'done'
  | 'stalled'
  | 'host_silent'
  | 'grouped'
  | 'group_closed';

export interface AlertData {
  type: 'alert';
  event_id: string;
  delivery_id: string;
  event_type: EventType;
  agent: string;
  host: string;
  summary: string;
  run_id: string;
  timestamp: string;
}

export interface StateData {
  type: 'state';
  on: 'true' | 'false';
  until: string;
  timestamp: string;
}

export type PushData = AlertData | StateData;

export interface FlagState {
  on: boolean;
  until: string | null;
  timestamp: string;
}

export function isAlertData(d: PushData): d is AlertData {
  return d.type === 'alert';
}

// --- Notification titles -------------------------------------------------

const HIGH_ATTENTION: ReadonlySet<EventType> = new Set([
  'question',
  'failed',
  'timed_out',
  'host_silent',
]);

// The grouped/closing wire payloads carry no count fields; the counts live in
// the server-rendered summary ("{n} events from {agent} in the last minute" /
// "{total} events from {agent} in the last minute; {suppressed} not shown
// individually"). Extract them; fall back to a generic title.
function groupTitle(d: AlertData): string {
  const m = /^(\d+)\s+events?\b/i.exec(d.summary);
  const n = m ? m[1] : null;
  if (d.event_type === 'grouped') {
    return n ? `${n} events from ${d.agent}` : `Events from ${d.agent}`;
  }
  const s = /;\s*(\d+)\s+not shown/i.exec(d.summary);
  const count = n ?? '';
  const suppressed = s ? s[1] : '';
  if (count && suppressed) return `${count} events from ${d.agent}; ${suppressed} not shown`;
  if (count) return `${count} events from ${d.agent}`;
  return `Events from ${d.agent}`;
}

// Named runs append " — {agent}" to the title; ad-hoc signals report the
// machine name as the agent (agent === host), which is noise in a title, so
// the name is dropped and the label stands alone.
function nameSuffix(d: AlertData): string {
  return d.agent && d.agent !== d.host ? ` — ${d.agent}` : '';
}

export function titleForAlert(d: AlertData): string {
  switch (d.event_type) {
    case 'question':
      return `Answer needed${nameSuffix(d)}`;
    case 'failed':
      return `Task failed${nameSuffix(d)}`;
    case 'timed_out':
      return `Task timed out${nameSuffix(d)}`;
    case 'done':
      return `Task finished${nameSuffix(d)}`;
    case 'stalled':
      return `Task stalled${nameSuffix(d)}`;
    case 'host_silent':
      return `Machine offline — ${d.host}`;
    case 'grouped':
    case 'group_closed':
      return groupTitle(d);
  }
}

export interface NotificationSpec {
  title: string;
  options: {
    body: string;
    tag: string;
    requireInteraction: boolean;
    data: AlertData;
  };
}

export function notificationForAlert(d: AlertData): NotificationSpec {
  return {
    title: titleForAlert(d),
    options: {
      body: d.summary,
      tag: d.run_id,
      requireInteraction: HIGH_ATTENTION.has(d.event_type),
      data: d,
    },
  };
}

// --- State messages --------------------------------------------------------

// Applies a state message only when its timestamp is strictly newer than the
// stored state. Returns the state to store, or null when the message is
// stale/equal.
export function nextFlagState(current: FlagState | undefined, msg: StateData): FlagState | null {
  if (current && msg.timestamp <= current.timestamp) return null;
  return {
    on: msg.on === 'true',
    until: msg.until === '' ? null : msg.until,
    timestamp: msg.timestamp,
  };
}

export async function applyStateMessage(msg: StateData): Promise<FlagState | null> {
  const current = await kvGet<FlagState>(KEY_STATE);
  const next = nextFlagState(current, msg);
  if (next) await kvSet(KEY_STATE, next);
  return next;
}

// --- Receipt outbox ----------------------------------------------------------

async function readOutbox(): Promise<string[]> {
  return (await kvGet<string[]>(KEY_OUTBOX)) ?? [];
}

async function writeOutbox(ids: string[]): Promise<void> {
  await kvSet(KEY_OUTBOX, ids);
}

export async function enqueueReceipt(deliveryId: string): Promise<void> {
  const ids = await readOutbox();
  if (!ids.includes(deliveryId)) {
    ids.push(deliveryId);
    await writeOutbox(ids);
  }
}

// Attempts the receipt; on failure the delivery_id goes to the outbox so a
// later push or activation retries it. Never dropped.
export async function sendReceipt(
  apiBase: string,
  deliveryId: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  try {
    const creds = await getDeviceCredentials();
    if (!creds) {
      await enqueueReceipt(deliveryId);
      return false;
    }
    await createDeviceApi(apiBase, { deviceId: creds.device_id, secret: creds.device_secret }, fetchImpl).receipt(
      deliveryId,
    );
    return true;
  } catch {
    await enqueueReceipt(deliveryId);
    return false;
  }
}

// Retries every queued receipt. Queued ids that fail stay queued.
export async function drainOutbox(apiBase: string, fetchImpl: FetchLike = fetch): Promise<number> {
  const ids = await readOutbox();
  if (ids.length === 0) return 0;
  const creds = await getDeviceCredentials();
  if (!creds) return ids.length;
  const api = createDeviceApi(apiBase, { deviceId: creds.device_id, secret: creds.device_secret }, fetchImpl);
  const remaining: string[] = [];
  for (const id of ids) {
    try {
      await api.receipt(id);
    } catch {
      remaining.push(id);
    }
  }
  await writeOutbox(remaining);
  return remaining.length;
}

// --- Message dispatch ---------------------------------------------------------

export interface ShowNotification {
  (title: string, options: NotificationSpec['options']): Promise<unknown>;
}

export interface HandleResult {
  notified: boolean;
  state?: FlagState | null;
}

// Handles one FCM data payload. Alerts always show a notification, then a
// receipt is sent (queued on failure). State messages update stored state and
// never show a notification. Also drains the receipt outbox.
export async function handlePushData(
  data: PushData,
  ctx: { apiBase: string; showNotification: ShowNotification; fetchImpl?: FetchLike },
): Promise<HandleResult> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  try {
    if (isAlertData(data)) {
      const spec = notificationForAlert(data);
      await ctx.showNotification(spec.title, spec.options);
      await sendReceipt(ctx.apiBase, data.delivery_id, fetchImpl);
      return { notified: true };
    }
    const state = await applyStateMessage(data);
    return { notified: false, state };
  } finally {
    try {
      await drainOutbox(ctx.apiBase, fetchImpl);
    } catch {
      // outbox drain is best-effort; the ids stay queued for the next attempt
    }
  }
}

// --- Notification click ----------------------------------------------------

export interface ClientLike {
  focused?: boolean;
  url?: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}

export interface NotificationEventLike {
  notification: { data?: AlertData; close(): void };
  waitUntil(p: Promise<unknown>): void;
}

export interface ClientsLike {
  matchAll(opts: { type: string; includeUncontrolled: boolean }): Promise<ClientLike[]>;
  openWindow(url: string): Promise<unknown>;
}

// Focuses an open app window and posts the alert (including event_id) to it;
// otherwise opens /?alert=<event_id>.
export async function handleNotificationClick(
  data: AlertData | undefined,
  clients: ClientsLike,
): Promise<void> {
  const eventId = data?.event_id ?? '';
  const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const target = list.find((c) => c.url?.startsWith(selfLocationOrigin())) ?? list[0];
  if (target) {
    target.postMessage({ kind: 'agentwatch-alert-click', alert: data ?? null, event_id: eventId });
    await target.focus();
    return;
  }
  await clients.openWindow(`/?alert=${encodeURIComponent(eventId)}`);
}

function selfLocationOrigin(): string {
  return (self as unknown as { location: { origin: string } }).location.origin;
}
