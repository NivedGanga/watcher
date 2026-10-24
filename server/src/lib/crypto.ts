import { createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';

export function hmac(pepper: string, value: string): string {
  return createHmac('sha256', pepper).update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two HMAC hex digests or raw strings. */
export function hmacEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function randomSecret(byteLength = 32): string {
  // alphanumeric secret (no underscore/dash ambiguity in key formats)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(byteLength);
  let out = '';
  for (let i = 0; i < byteLength; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateUserCode(): string {
  const bytes = randomBytes(8);
  let raw = '';
  for (let i = 0; i < 8; i++) raw += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Normalize a user code for matching: uppercase, dash removed. Returns null if malformed. */
export function normalizeUserCode(input: string): string | null {
  const cleaned = input.replace(/-/g, '').toUpperCase();
  if (!/^[A-Z2-9]{8}$/.test(cleaned)) return null;
  if (![...cleaned].every((ch) => USER_CODE_ALPHABET.includes(ch))) return null;
  return cleaned;
}

export function formatUserCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

export function aesGcmEncrypt(keyB64: string, plaintext: string): string {
  const key = Buffer.from(keyB64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function aesGcmDecrypt(keyB64: string, encoded: string): string {
  const key = Buffer.from(keyB64, 'base64');
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
