// user_code normalization: uppercase, strip spaces and dashes, display as
// XXXX-XXXX.

export function normalizeUserCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, '');
}

export function formatUserCode(raw: string): string {
  const c = normalizeUserCode(raw);
  if (c.length <= 4) return c;
  return `${c.slice(0, 4)}-${c.slice(4, 8)}`;
}
