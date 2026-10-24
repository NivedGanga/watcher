import type { Context } from 'hono';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function apiError(c: Context, status: number, code: string, message: string, headers?: Record<string, string>) {
  if (headers) {
    for (const [k, v] of Object.entries(headers)) c.header(k, v);
  }
  return c.json(errorBody(code, message), status as 400);
}

export function validationFailed(c: Context, message = 'Request failed validation') {
  return apiError(c, 400, 'validation_failed', message);
}

export function unauthorized(c: Context) {
  return apiError(c, 401, 'unauthorized', 'Missing, malformed, or invalid credential');
}

export function notFound(c: Context) {
  return apiError(c, 404, 'not_found', 'Resource does not exist');
}

export function emailNotVerified(c: Context) {
  return apiError(c, 403, 'email_not_verified', 'Account email is not verified');
}

export function limitReached(c: Context) {
  return apiError(c, 409, 'limit_reached', 'Account limit exceeded');
}

export function upgradeRequired(c: Context) {
  return apiError(c, 426, 'upgrade_required', 'Unsupported protocol version');
}

export function rateLimited(c: Context, retryAfterSeconds: number) {
  return apiError(c, 429, 'rate_limited', 'Rate limit exceeded', {
    'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))),
  });
}
