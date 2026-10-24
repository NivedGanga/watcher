// Minimal IndexedDB key-value helper, shared by the page and the service
// worker (bundled into the SW by scripts/build-sw.mjs). No dependencies so it
// can run in a service worker without importScripts.
//
// One object store, key -> structured-cloneable value.

const DB_NAME = 'agentwatch';
const STORE = 'kv';
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
  }
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export function kvGet<T = unknown>(key: string): Promise<T | undefined> {
  return tx<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function kvSet(key: string, value: unknown): Promise<void> {
  return tx<IDBValidKey>('readwrite', (s) => s.put(value, key)).then(() => undefined);
}

export function kvDel(key: string): Promise<void> {
  return tx<undefined>('readwrite', (s) => s.delete(key)).then(() => undefined);
}

export function kvClear(): Promise<void> {
  return tx<undefined>('readwrite', (s) => s.clear()).then(() => undefined);
}

// Well-known keys.
export const KEY_DEVICE = 'device'; // { device_id, device_secret }
export const KEY_OUTBOX = 'receipt_outbox'; // string[] of delivery_ids
export const KEY_STATE = 'flag_state'; // { on, until, timestamp }
export const KEY_SEEN_PING = 'seen_ping_at'; // ms epoch of last POST /api/devices/seen

export interface DeviceCredentials {
  device_id: string;
  device_secret: string;
}

export function getDeviceCredentials(): Promise<DeviceCredentials | undefined> {
  return kvGet<DeviceCredentials>(KEY_DEVICE);
}

export function setDeviceCredentials(creds: DeviceCredentials): Promise<void> {
  return kvSet(KEY_DEVICE, creds);
}

export function clearDeviceCredentials(): Promise<void> {
  return kvDel(KEY_DEVICE);
}
