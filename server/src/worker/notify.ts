import type { Config } from '../config.js';
import type { Deps, PushProvider } from '../providers/types.js';
import { PUSH_NOT_REGISTERED, PushError } from '../providers/types.js';
import * as repo from '../repo.js';
import type { EventRow, DeliveryRow, DeviceRow } from '../repo.js';
import { rfc3339, EMAIL_MONTHLY_CAP, monthKey } from '../lib/time.js';
import { aesGcmDecrypt } from '../lib/crypto.js';
import { log } from '../lib/logger.js';

export interface PushPayloadData {
  eventType: string;
  urgency: 'high' | 'normal';
  summary: string;
}

/** Build the FCM data-only payload. Every value must be a string. */
export function alertPushData(
  event: Pick<EventRow, 'id' | 'agent' | 'host' | 'runId' | 'eventTimestamp'>,
  deliveryId: string,
  p: PushPayloadData,
): Record<string, string> {
  const ts =
    event.eventTimestamp instanceof Date
      ? rfc3339(event.eventTimestamp)
      : String(event.eventTimestamp);
  return {
    type: 'alert',
    event_id: String(event.id),
    delivery_id: String(deliveryId),
    event_type: String(p.eventType),
    agent: String(event.agent),
    host: String(event.host),
    summary: String(p.summary),
    run_id: String(event.runId),
    timestamp: ts,
  };
}

export function statePushData(on: boolean, until: string | null, now: Date): Record<string, string> {
  return {
    type: 'state',
    on: on ? 'true' : 'false',
    until: on && until ? until : '',
    timestamp: rfc3339(now),
  };
}

export class NotRegistered extends Error {}

/**
 * Send one push message to a device. Revokes the device (and reports
 * NotRegistered) on FCM registration-token-not-registered.
 */
export async function sendPushToDevice(
  db: repo.Q,
  deps: Pick<Deps, 'push'>,
  config: Config,
  device: DeviceRow,
  data: Record<string, string>,
  urgency: 'high' | 'normal',
  ttlSeconds: number,
): Promise<void> {
  const token = aesGcmDecrypt(config.deviceTokenEncKey, device.fcmTokenEnc);
  try {
    await deps.push.send({
      token,
      data,
      headers: { Urgency: urgency, TTL: String(ttlSeconds) },
    });
  } catch (err) {
    if (err instanceof PushError && err.code === PUSH_NOT_REGISTERED) {
      await repo.revokeDeviceById(db, device.id, new Date());
      throw new NotRegistered();
    }
    throw err;
  }
}

const MAX_ATTEMPTS = 5;

function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 10 * 60_000);
}

/**
 * Execute one delivery (push or email). Claimed by caller via attempts
 * increment; this function updates the final/retry state.
 */
export async function executeDelivery(
  db: repo.Q,
  delivery: DeliveryRow,
  deps: Deps,
  config: Config,
  now: Date,
): Promise<void> {
  const attempts = delivery.attempts; // already incremented by claimer
  const retry = async () => {
    if (attempts >= MAX_ATTEMPTS) {
      await repo.markDelivery(db, delivery.id, { status: 'failed' });
    } else {
      await repo.markDelivery(db, delivery.id, {
        status: 'pending',
        nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
      });
    }
  };

  const event = await repo.getEvent(db, delivery.userId, delivery.eventId);
  if (!event) {
    await repo.markDelivery(db, delivery.id, { status: 'failed', skipReason: 'event_missing' });
    return;
  }

  if (delivery.channel === 'push') {
    const device = delivery.deviceId ? await repo.getDevice(db, delivery.deviceId) : undefined;
    if (!device || device.revokedAt) {
      await repo.markDelivery(db, delivery.id, { status: 'skipped', skipReason: 'device_revoked' });
      return;
    }
    const p = (delivery.payload ?? {}) as Partial<PushPayloadData>;
    try {
      await sendPushToDevice(
        db,
        deps,
        config,
        device,
        alertPushData(event, delivery.id, {
          eventType: p.eventType ?? event.type,
          urgency: p.urgency ?? 'normal',
          summary: p.summary ?? event.summary,
        }),
        p.urgency ?? 'normal',
        3600,
      );
      await repo.markDelivery(db, delivery.id, { status: 'sent', sentAt: now });
    } catch (err) {
      if (err instanceof NotRegistered) {
        await repo.markDelivery(db, delivery.id, {
          status: 'failed',
          skipReason: 'token_not_registered',
        });
        return; // do not retry
      }
      log.warn('push send failed', { deliveryId: delivery.id });
      await retry();
    }
    return;
  }

  // email
  const user = await repo.getUser(db, delivery.userId);
  if (!user || !user.emailVerified) {
    await repo.markDelivery(db, delivery.id, { status: 'skipped', skipReason: 'email_unverified' });
    return;
  }
  if (user.deletedAt) {
    await repo.markDelivery(db, delivery.id, { status: 'skipped', skipReason: 'account_deleted' });
    return;
  }
  const sent = await repo.emailsSentThisMonth(db, delivery.userId, now);
  if (sent >= EMAIL_MONTHLY_CAP) {
    await repo.markDelivery(db, delivery.id, { status: 'skipped', skipReason: 'email_cap' });
    return;
  }
  const kind = (delivery.payload?.['kind'] as string | undefined) ?? 'alert';
  const msg = buildEmail(event, kind, config);
  try {
    await deps.email.send({ from: config.emailFrom, to: user.email, ...msg });
    await repo.incrementEmailsSent(db, delivery.userId, now);
    await repo.markDelivery(db, delivery.id, { status: 'sent', sentAt: now });
    log.info('email sent', { deliveryId: delivery.id, kind });
  } catch {
    log.warn('email send failed', { deliveryId: delivery.id });
    await retry();
  }
}

export function buildEmail(
  event: EventRow,
  kind: string,
  config: Config,
): { subject: string; text: string } {
  if (kind === 'host_silent' || event.type === 'host_silent') {
    const subject = `[agentwatch] ${event.host} has stopped reporting.`;
    const text = `${event.host} has stopped reporting.\n\nmachine: ${event.host}\ntime: ${rfc3339(event.eventTimestamp)}\n\nManage alerts: ${config.appUrl}`;
    return { subject, text };
  }
  const eventType =
    kind === 'grouped' || kind === 'group_closed' ? kind : event.type;
  const subject = `[agentwatch] ${event.agent}: ${eventType} on ${event.host}`;
  const lines = [
    event.summary,
    '',
    `run_id: ${event.runId}`,
    `time: ${rfc3339(event.eventTimestamp)}`,
  ];
  if (event.durationS !== null) lines.push(`duration: ${event.durationS}s`);
  if (event.exitCode !== null) lines.push(`exit code: ${event.exitCode}`);
  if (kind === 'reminder') lines.unshift('Reminder: this question may still be unanswered.');
  return { subject, text: lines.join('\n') };
}

/** Send a state message to all active devices of a user. */
export async function sendStatePushes(
  db: repo.Q,
  deps: Deps,
  config: Config,
  userId: string,
  now: Date,
): Promise<number> {
  const user = await repo.getUser(db, userId);
  if (!user) return 0;
  const devices = await repo.listActiveDevices(db, userId, now);
  const until =
    user.notifyOnPhone && user.phoneAlertsSince
      ? rfc3339(new Date(user.phoneAlertsSince.getTime() + config.awayMaxHours * 3_600_000))
      : null;
  const data = statePushData(user.notifyOnPhone, until, now);
  let sent = 0;
  for (const device of devices) {
    try {
      await sendPushToDevice(db, deps, config, device, data, 'normal', 300);
      sent++;
    } catch (err) {
      if (!(err instanceof NotRegistered)) throw err;
    }
  }
  return sent;
}
