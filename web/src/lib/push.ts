// Browser push registration, seen-ping, and foreground message handling.

import { getToken, onMessage, type Messaging } from 'firebase/messaging';
import { getConfig } from '../config';
import { createDeviceApi, createUserApi } from './api';
import { firebaseMessaging } from './firebase';
import {
  clearDeviceCredentials,
  getDeviceCredentials,
  kvGet,
  kvSet,
  setDeviceCredentials,
  KEY_SEEN_PING,
  type DeviceCredentials,
} from './kv';
import {
  applyStateMessage,
  handlePushData,
  type AlertData,
  type PushData,
} from '../shared/awsw';

export type PushSupport = 'ok' | 'ios-standalone-required' | 'unsupported';

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  if (!('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (!window.isSecureContext) return 'unsupported';
  if (isIos() && !isStandalone()) return 'ios-standalone-required';
  return 'ok';
}

export function isIos(): boolean {
  const ua = navigator.userAgent;
  if (/iP(hone|ad|od)/.test(ua)) return true;
  // iPadOS reports as Mac; detect via touch.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

let swRegistration: Promise<ServiceWorkerRegistration> | null = null;

export function registerPushServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!swRegistration) {
    swRegistration = navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
    swRegistration.catch(() => {
      swRegistration = null;
    });
  }
  return swRegistration;
}

export type RegistrationResult =
  | { status: 'registered'; deviceId: string }
  | { status: 'permission-denied' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

// Requests permission, gets an FCM token for our service worker, registers it
// with the API, and stores the returned device credentials in IndexedDB.
export async function enablePushInThisBrowser(
  getIdToken: () => Promise<string>,
): Promise<RegistrationResult> {
  if (pushSupport() !== 'ok') return { status: 'unsupported' };
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { status: 'permission-denied' };

    const messaging: Messaging | null = await firebaseMessaging();
    if (!messaging) return { status: 'unsupported' };

    const registration = await registerPushServiceWorker();
    const token = await getToken(messaging, {
      vapidKey: getConfig().vapidKey,
      serviceWorkerRegistration: registration,
    });

    const api = createUserApi(getConfig().apiBaseUrl, getIdToken);
    const reg = await api.registerDevice(token);
    const creds: DeviceCredentials = { device_id: reg.device_id, device_secret: reg.device_secret };
    await setDeviceCredentials(creds);
    return { status: 'registered', deviceId: reg.device_id };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : 'Registration failed' };
  }
}

export async function thisBrowserDevice(): Promise<DeviceCredentials | undefined> {
  return getDeviceCredentials();
}

const SEEN_INTERVAL_MS = 24 * 60 * 60 * 1000;

// POST /api/devices/seen at most once per day, when this browser is a
// registered device.
export async function seenPingOnceADay(now = Date.now()): Promise<void> {
  const creds = await getDeviceCredentials();
  if (!creds) return;
  const last = (await kvGet<number>(KEY_SEEN_PING)) ?? 0;
  if (now - last < SEEN_INTERVAL_MS) return;
  try {
    await createDeviceApi(getConfig().apiBaseUrl, {
      deviceId: creds.device_id,
      secret: creds.device_secret,
    }).seen();
    await kvSet(KEY_SEEN_PING, now);
  } catch {
    // best-effort; try again on next load
  }
}

export interface ForegroundHandlers {
  onAlert(alert: AlertData): void;
  onState?(state: { on: boolean; until: string | null }): void;
}

// Subscribes to foreground FCM messages. Alerts join the session list, are
// shown once through the service worker registration, and get a receipt.
// State messages update stored flag state and never show a notification.
export async function listenForeground(handlers: ForegroundHandlers): Promise<() => void> {
  const messaging = await firebaseMessaging();
  if (!messaging) return () => undefined;
  return onMessage(messaging, async (payload) => {
    const data = payload.data as PushData | undefined;
    if (!data || typeof data !== 'object' || !('type' in data)) return;
    if (data.type === 'alert') {
      handlers.onAlert(data);
      const registration = await registerPushServiceWorker().catch(() => null);
      if (!registration) return;
      await handlePushData(data, {
        apiBase: getConfig().apiBaseUrl,
        showNotification: (title, options) => registration.showNotification(title, options),
      });
    } else if (data.type === 'state') {
      const state = await applyStateMessage(data);
      if (state && handlers.onState) handlers.onState(state);
    }
  });
}

export async function forgetThisBrowser(): Promise<void> {
  await clearDeviceCredentials();
}
