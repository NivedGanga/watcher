// AgentWatch API client (protocol version 1).
// Every request carries X-AgentWatch-Protocol: 1. Errors use the spec envelope
// {"error": {"code", "message"}} and surface as ApiError.

export const PROTOCOL_HEADER = 'X-AgentWatch-Protocol';
export const PROTOCOL_VERSION = '1';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type Auth =
  | { kind: 'bearer'; token: string }
  | { kind: 'device'; deviceId: string; secret: string }
  | { kind: 'none' };

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface RequestOpts {
  method?: string;
  body?: unknown;
  auth: Auth;
}

function authHeader(auth: Auth): string | null {
  switch (auth.kind) {
    case 'bearer':
      return `Bearer ${auth.token}`;
    case 'device':
      return `Device ${auth.deviceId}.${auth.secret}`;
    case 'none':
      return null;
  }
}

export async function apiRequest<T = unknown>(
  baseUrl: string,
  path: string,
  opts: RequestOpts,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const headers: Record<string, string> = {
    [PROTOCOL_HEADER]: PROTOCOL_VERSION,
    'Content-Type': 'application/json',
  };
  const auth = authHeader(opts.auth);
  if (auth) headers['Authorization'] = auth;

  const res = await fetchImpl(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // fall through to status-based error
    }
  }

  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? `http_${res.status}`,
      err?.message ?? `Request failed with status ${res.status}`,
    );
  }
  return json as T;
}

// --- Web app (Firebase ID token) endpoints ---

export interface MeResponse {
  notify_on_phone: boolean;
  phone_alerts_since: string | null;
  until: string | null;
  email: string;
  active_device_count: number;
  machine_count: number;
}

export interface NotificationsResponse {
  notify_on_phone: boolean;
  phone_alerts_since: string | null;
  until: string | null;
}

export interface Machine {
  id: string;
  name: string;
  os: string;
  last_heartbeat_at: string | null;
  active_runs: number;
}

export interface DeviceRegistration {
  device_id: string;
  device_secret: string;
}

export interface PendingDevice {
  user_code: string;
  client_name: string;
  client_os: string;
  expires_at: string;
}

export interface RecentEvent {
  event_id: string;
  event_type: string;
  agent: string;
  host: string;
  summary: string;
  run_id: string;
  timestamp: string;
}

export interface UserApi {
  me(): Promise<MeResponse>;
  setNotifications(enabled: boolean): Promise<NotificationsResponse>;
  recentEvents(limit?: number): Promise<{ events: RecentEvent[] }>;
  deleteMe(): Promise<void>;
  machines(): Promise<Machine[]>;
  deleteMachine(id: string): Promise<void>;
  registerDevice(fcmToken: string): Promise<DeviceRegistration>;
  deleteDevice(id: string): Promise<void>;
  pendingApproval(userCode: string): Promise<PendingDevice>;
  approveDevice(userCode: string): Promise<{ approved: boolean }>;
  denyDevice(userCode: string): Promise<{ approved: boolean }>;
}

// getToken must return a fresh Firebase ID token for the signed-in user.
export function createUserApi(baseUrl: string, getToken: () => Promise<string>): UserApi {
  const call = async <T>(path: string, method: string, body?: unknown): Promise<T> => {
    const token = await getToken();
    return apiRequest<T>(baseUrl, path, { method, body, auth: { kind: 'bearer', token } });
  };
  return {
    me: () => call('/api/me', 'GET'),
    setNotifications: (enabled) => call('/api/me/notifications', 'PUT', { enabled }),
    recentEvents: (limit = 20) => call(`/api/me/events?limit=${limit}`, 'GET'),
    deleteMe: () => call('/api/me', 'DELETE'),
    machines: () => call('/api/me/machines', 'GET'),
    deleteMachine: (id) => call(`/api/me/machines/${encodeURIComponent(id)}`, 'DELETE'),
    registerDevice: (fcmToken) => call('/api/devices', 'POST', { fcm_token: fcmToken }),
    deleteDevice: (id) => call(`/api/devices/${encodeURIComponent(id)}`, 'DELETE'),
    pendingApproval: (userCode) =>
      call(`/api/device/pending?user_code=${encodeURIComponent(userCode)}`, 'GET'),
    approveDevice: (userCode) => call('/api/device/approve', 'POST', { user_code: userCode }),
    denyDevice: (userCode) => call('/api/device/deny', 'POST', { user_code: userCode }),
  };
}

// --- Browser (device secret) endpoints ---

export interface DeviceApi {
  receipt(deliveryId: string): Promise<void>;
  seen(): Promise<void>;
}

export function createDeviceApi(
  baseUrl: string,
  creds: { deviceId: string; secret: string },
  fetchImpl?: FetchLike,
): DeviceApi {
  const auth: Auth = { kind: 'device', deviceId: creds.deviceId, secret: creds.secret };
  return {
    receipt: (deliveryId) =>
      apiRequest(baseUrl, '/api/receipts', { method: 'POST', body: { delivery_id: deliveryId }, auth }, fetchImpl),
    seen: () => apiRequest(baseUrl, '/api/devices/seen', { method: 'POST', body: {}, auth }, fetchImpl),
  };
}
