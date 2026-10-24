import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import eventSchema from '../../spec/schemas/event.schema.json';
import signalSchema from '../../spec/schemas/signal.schema.json';
import heartbeatSchema from '../../spec/schemas/heartbeat.schema.json';

const ajv = new Ajv2020({ strict: false, allErrors: false });
// The wire requirement (UTC ending in Z) is enforced by each schema's pattern;
// ajv's date-time format check is not needed.
ajv.addFormat('date-time', () => true);

export const validateEvent: ValidateFunction = ajv.compile(eventSchema);
export const validateSignal: ValidateFunction = ajv.compile(signalSchema);
export const validateHeartbeat: ValidateFunction = ajv.compile(heartbeatSchema);

export function firstError(validate: ValidateFunction): string {
  const err = validate.errors?.[0];
  if (!err) return 'validation failed';
  const path = err.instancePath ? `${err.instancePath.slice(1)} ` : '';
  return `${path}${err.message ?? 'invalid'}`;
}

/** Validate a plain object with only the listed keys; each key maps to a predicate. */
export function validateBody<T extends Record<string, unknown>>(
  body: unknown,
  shape: Record<string, (v: unknown) => boolean>,
): { ok: true; value: T } | { ok: false; reason: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'body must be an object' };
  }
  const obj = body as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in shape)) return { ok: false, reason: `unknown field: ${key}` };
  }
  for (const [key, check] of Object.entries(shape)) {
    if (!(key in obj)) return { ok: false, reason: `missing field: ${key}` };
    if (!check(obj[key])) return { ok: false, reason: `invalid field: ${key}` };
  }
  return { ok: true, value: obj as T };
}

export const isString = (v: unknown): v is string => typeof v === 'string';
export const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
export const isNonEmptyString = (max: number) => (v: unknown): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= max;
