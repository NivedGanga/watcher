/** Format a Date as RFC 3339 UTC without fractional seconds (ends in Z). */
export function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7); // YYYY-MM
}

export const MINUTE_MS = 60_000;
export const DEVICE_ACTIVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const SILENCE_THRESHOLD_MS = 15 * 60_000;
export const FALLBACK_DELAY_MS = 120_000;
export const REMINDER_DELAY_MS = 600_000;
export const GROUP_WINDOW_MS = 60_000;
export const DEDUPE_WINDOW_MS = 600_000;
export const EMAIL_MONTHLY_CAP = 200;
export const MACHINE_LIMIT = 5;
export const DEVICE_LIMIT = 5;
