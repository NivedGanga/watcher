/**
 * Minimal logger. Never log env values, tokens, secrets, codes, email bodies,
 * or summaries — only ids, counts, and statuses.
 */
type Fields = Record<string, string | number | boolean | null | undefined>;

function emit(level: string, msg: string, fields?: Fields) {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v === undefined) continue;
    if (typeof v === 'string' && v.length > 64) {
      safe[k] = `${v.slice(0, 16)}…`; // defensive truncation; callers must not pass secrets
    } else {
      safe[k] = v;
    }
  }
  const line = JSON.stringify({ level, msg, ...safe, ts: new Date().toISOString() });
  (level === 'error' ? console.error : console.log)(line);
}

export const log = {
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
};
