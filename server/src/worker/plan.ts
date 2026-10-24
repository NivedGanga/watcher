import * as repo from '../repo.js';
import type { RoutePlan } from '../routing/route.js';
import type { Deps } from '../providers/types.js';

/**
 * Persist a RoutePlan: push/email deliveries, scheduled jobs, group updates.
 * Called inside the ingest transaction (or the silence-check transaction).
 */
export async function applyRoutePlan(
  db: repo.Q,
  deps: Pick<Deps, 'jobs'>,
  userId: string,
  event: { id: string; agent: string },
  plan: RoutePlan,
): Promise<{ pushDeliveryIds: string[] }> {
  const pushDeliveryIds: string[] = [];
  for (const p of plan.pushes) {
    const id = await repo.insertDelivery(db, {
      userId,
      eventId: event.id,
      channel: 'push',
      deviceId: p.deviceId,
      payload: { eventType: p.eventType, urgency: p.urgency, summary: p.summary },
    });
    pushDeliveryIds.push(id);
  }
  if (plan.emailNow && plan.emailKind) {
    await repo.insertDelivery(db, {
      userId,
      eventId: event.id,
      channel: 'email',
      deviceId: null,
      payload: { kind: plan.emailKind },
    });
  }
  for (const j of plan.jobs) {
    const runAt = new Date(j.runAt);
    if (j.kind === 'email_fallback') {
      await deps.jobs.enqueue(
        'email_fallback',
        { user_id: userId, event_id: event.id },
        runAt,
        { dbOrTx: db, dedupeKey: `fb:${event.id}` },
      );
    } else if (j.kind === 'group_close' && plan.group) {
      await deps.jobs.enqueue(
        'group_close',
        {
          user_id: userId,
          agent: event.agent,
          window_start: new Date(plan.group.windowStart).toISOString(),
        },
        runAt,
        { dbOrTx: db, dedupeKey: `gc:${userId}:${event.agent}:${plan.group.windowStart}` },
      );
    }
  }
  return { pushDeliveryIds };
}
