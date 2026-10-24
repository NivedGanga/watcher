/**
 * Pure routing engine. All notification decisions for a single event are made
 * here, given a snapshot of account state. The result is a plan that callers
 * (HTTP ingest path, scheduler, conformance harness) persist or execute.
 *
 * Implements the Routing table + Modifiers + Grouping rules from spec/SPEC.md.
 */

export const GROUP_WINDOW_MS = 60_000;
export const FALLBACK_DELAY_MS = 120_000;

export const COUNTED_TYPES = new Set(['question', 'done', 'stalled']);
const HIGH_URGENCY = new Set(['failed', 'timed_out', 'question', 'host_silent']);

export interface RouteEvent {
  id: string;
  type: string;
  agent: string;
  runId: string;
  host: string;
  summary: string;
  emailAllowed: boolean;
  eventTimestamp: number; // ms epoch
}

export interface RouteAccount {
  notifyOnPhone: boolean;
  phoneAlertsSince: number | null; // ms epoch
  emailVerified: boolean;
}

export interface RouteGroup {
  windowStart: number; // ms epoch
  count: number;
  suppressed: number;
}

export interface RouteState {
  now: number; // ms epoch
  account: RouteAccount;
  activeDeviceIds: string[];
  /** Open grouping window for (user, agent), or null. */
  group: RouteGroup | null;
  awayMaxHours: number;
}

export type Routing =
  | 'push'
  | 'push+email_fallback'
  | 'push+email'
  | 'email'
  | 'none'
  | 'grouped'
  | 'suppressed';

export interface PushPlan {
  deviceId: string;
  urgency: 'high' | 'normal';
  /** event_type value in the push payload: event type, 'grouped', or 'group_closed'. */
  eventType: string;
  summary: string;
}

export interface JobPlan {
  kind: 'email_fallback' | 'group_close';
  runAt: number;
}

export interface GroupUpdate {
  action: 'create' | 'count' | 'suppress';
  windowStart: number;
  count: number;
  suppressed: number;
  latestEventId: string;
  latestSummary: string;
  /** The event that triggered (position-6) the grouped message, if known. */
  triggerEventId?: string;
}

export interface RoutePlan {
  routing: Routing;
  pushes: PushPlan[];
  /** Create a pending email delivery to be sent on the next drain. */
  emailNow: boolean;
  emailKind: 'immediate' | 'host_silent' | 'grouped' | 'group_closed' | null;
  jobs: JobPlan[];
  group?: GroupUpdate;
}

/** The away flag, accounting for the hard cap deadline (SPEC: events after the deadline are routed with the flag off). */
export function effectiveFlag(account: RouteAccount, now: number, awayMaxHours: number): boolean {
  if (!account.notifyOnPhone) return false;
  if (account.phoneAlertsSince === null) return true;
  return now < account.phoneAlertsSince + awayMaxHours * 3_600_000;
}

interface TableResult {
  routing: Routing;
  pushes: PushPlan[];
  emailNow: boolean;
  emailKind: 'immediate' | 'host_silent' | 'grouped' | 'group_closed' | null;
  fallbackJob: boolean;
}

/**
 * The 2x2 Routing table for question/failed/timed_out/done, plus modifiers.
 * `eventType`/`summary`/`urgencyOverride` let grouped and closing messages
 * reuse the table.
 */
function tableRoute(
  event: RouteEvent,
  state: RouteState,
  opts: {
    eventType?: string;
    summary?: string;
    urgency?: 'high' | 'normal';
    /** underlying type used for email gating and fallback semantics */
    asType?: string;
    emailKind?: 'immediate' | 'host_silent' | 'grouped' | 'group_closed';
  } = {},
): TableResult {
  const asType = opts.asType ?? event.type;
  const eventType = opts.eventType ?? event.type;
  const summary = opts.summary ?? event.summary;
  const urgency =
    opts.urgency ?? (HIGH_URGENCY.has(asType) ? 'high' : 'normal');
  const flag = effectiveFlag(state.account, state.now, state.awayMaxHours);
  const hasApp = state.activeDeviceIds.length > 0;

  // Email gate: 'done' (and grouped/closing messages it triggers) requires
  // email_allowed. Every other type ignores it. 'stalled' never emails.
  const emailAllowed = asType === 'done' ? event.emailAllowed : true;
  const canEmail = asType !== 'stalled' && emailAllowed;

  const pushesFor = (): PushPlan[] =>
    state.activeDeviceIds.map((deviceId) => ({ deviceId, urgency, eventType, summary }));

  if (asType === 'host_silent') {
    // Always email; high-urgency push to all active devices regardless of flag.
    return {
      routing: hasApp ? 'push+email' : 'email',
      pushes: pushesFor(),
      emailNow: true,
      emailKind: 'host_silent',
      fallbackJob: false,
    };
  }

  if (asType === 'stalled') {
    if (flag && hasApp) {
      return { routing: 'push', pushes: pushesFor(), emailNow: false, emailKind: null, fallbackJob: false };
    }
    return { routing: 'none', pushes: [], emailNow: false, emailKind: null, fallbackJob: false };
  }

  // question / failed / timed_out / done
  if (flag && hasApp) {
    return {
      routing: canEmail ? 'push+email_fallback' : 'push',
      pushes: pushesFor(),
      emailNow: false,
      emailKind: null,
      fallbackJob: canEmail,
    };
  }
  if (flag && !hasApp) {
    return { routing: 'none', pushes: [], emailNow: false, emailKind: null, fallbackJob: false };
  }
  if (!flag && hasApp) {
    return { routing: 'none', pushes: [], emailNow: false, emailKind: null, fallbackJob: false };
  }
  // flag off, no app
  if (canEmail) {
    return {
      routing: 'email',
      pushes: [],
      emailNow: true,
      emailKind: opts.emailKind ?? 'immediate',
      fallbackJob: false,
    };
  }
  return { routing: 'none', pushes: [], emailNow: false, emailKind: null, fallbackJob: false };
}

export function groupedSummary(count: number, agent: string, latestSummary: string): string {
  return `${count} events from ${agent} in the last minute: ${latestSummary}`;
}

export function closingSummary(total: number, agent: string, suppressed: number): string {
  return `${total} events from ${agent} in the last minute; ${suppressed} not shown individually`;
}

/**
 * Route the group-closing message through the table using the triggering
 * event's type, urgency normal. Used by the group_close job.
 */
export function tableRouteForClose(
  event: RouteEvent,
  state: RouteState,
  triggerType: string,
  eventType: 'grouped' | 'group_closed',
  summary: string,
): RoutePlan {
  const r = tableRoute(event, state, {
    eventType,
    summary,
    urgency: 'normal',
    asType: triggerType,
    emailKind: eventType === 'group_closed' ? 'group_closed' : 'grouped',
  });
  return toPlan(r, state.now, undefined);
}

/**
 * Route a single stored event. Grouping applies to question/done/stalled;
 * failed/timed_out are never counted; host_silent bypasses grouping entirely.
 */
export function route(event: RouteEvent, state: RouteState): RoutePlan {
  if (!COUNTED_TYPES.has(event.type)) {
    const r = tableRoute(event, state);
    return toPlan(r, state.now, undefined);
  }

  // Grouping: find the open window this event belongs to.
  const group = state.group;
  const inWindow =
    group !== null &&
    event.eventTimestamp >= group.windowStart &&
    event.eventTimestamp < group.windowStart + GROUP_WINDOW_MS;
  const position = inWindow ? group.count + 1 : 1;
  const windowStart = inWindow ? group.windowStart : event.eventTimestamp;

  const baseUpdate: Omit<GroupUpdate, 'action' | 'count' | 'suppressed'> = {
    windowStart,
    latestEventId: event.id,
    latestSummary: event.summary,
  };

  if (position >= 7) {
    return {
      routing: 'suppressed',
      pushes: [],
      emailNow: false,
      emailKind: null,
      jobs: [],
      group: {
        ...baseUpdate,
        action: 'suppress',
        count: position,
        suppressed: (inWindow ? group!.suppressed : 0) + 1,
      },
    };
  }

  if (position === 6) {
    const summary = groupedSummary(6, event.agent, event.summary);
    const r = tableRoute(event, state, {
      eventType: 'grouped',
      summary,
      urgency: 'normal',
      asType: event.type,
      emailKind: 'grouped',
    });
    const plan = toPlan(r, state.now, {
      ...baseUpdate,
      action: 'count',
      count: 6,
      suppressed: inWindow ? group!.suppressed : 0,
      triggerEventId: event.id,
    });
    plan.routing = 'grouped';
    return plan;
  }

  // positions 1-5: normal routing; open or bump the window.
  const r = tableRoute(event, state);
  const groupUpdate: GroupUpdate = {
    ...baseUpdate,
    action: position === 1 ? 'create' : 'count',
    count: position,
    suppressed: inWindow ? group!.suppressed : 0,
  };
  const plan = toPlan(r, state.now, groupUpdate);
  if (position === 1) {
    plan.jobs.push({ kind: 'group_close', runAt: windowStart + GROUP_WINDOW_MS });
  }
  return plan;
}

function toPlan(r: TableResult, now: number, group: GroupUpdate | undefined): RoutePlan {
  const jobs: JobPlan[] = [];
  if (r.fallbackJob) {
    // The 2-minute fallback window starts when the pushes are sent; they are
    // queued now, so the check is scheduled now + 120s.
    jobs.push({ kind: 'email_fallback', runAt: now + FALLBACK_DELAY_MS });
  }
  const plan: RoutePlan = {
    routing: r.routing,
    pushes: r.pushes,
    emailNow: r.emailNow,
    emailKind: r.emailKind,
    jobs,
    ...(group !== undefined ? { group } : {}),
  };
  return plan;
}

/** Auto-off: does an input_resumed signal turn the flag off? */
export function shouldAutoOff(
  account: RouteAccount,
  signal: { at: number; idleSeconds: number },
  returnIdleSeconds: number,
): boolean {
  if (!account.notifyOnPhone) return false;
  if (account.phoneAlertsSince === null) return false;
  return signal.idleSeconds >= returnIdleSeconds && signal.at > account.phoneAlertsSince;
}

/** Silence check: is a machine silent at `now`? */
export function isSilent(lastHeartbeatAt: number | null, now: number): boolean {
  if (lastHeartbeatAt === null) return false;
  return now - lastHeartbeatAt >= 15 * 60_000;
}

/** Hard cap: must the flag be turned off at `now`? */
export function hardCapExceeded(account: RouteAccount, now: number, awayMaxHours: number): boolean {
  return (
    account.notifyOnPhone &&
    account.phoneAlertsSince !== null &&
    now >= account.phoneAlertsSince + awayMaxHours * 3_600_000
  );
}

/** Device activity rule from SPEC: active iff not revoked AND last_seen_at strictly within 14 days. */
export function isDeviceActive(
  device: { revokedAt: number | null; lastSeenAt: number | null },
  now: number,
): boolean {
  if (device.revokedAt !== null) return false;
  if (device.lastSeenAt === null) return false;
  return now - device.lastSeenAt < 14 * 24 * 3_600_000;
}
