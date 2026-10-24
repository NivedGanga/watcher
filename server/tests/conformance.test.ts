import { describe, it, expect } from 'vitest';
import cases from '../spec/routing-cases.json';
import {
  route,
  tableRouteForClose,
  shouldAutoOff,
  isSilent,
  hardCapExceeded,
  isDeviceActive,
  type RouteEvent,
  type RoutePlan,
} from '../src/routing/route.js';

/**
 * In-memory conformance harness for spec/routing-cases.json.
 * Mirrors the server: the same pure route() function, the same job semantics
 * (fallback check at push+120s, reminder at question+600s, group close at
 * window+60s), the same flag/auto-off/silence rules.
 */

const T = (s: string) => new Date(s).getTime();
const AWAY_MAX_HOURS = 8;

interface SimDevice {
  id: string;
  revokedAt: number | null;
  lastSeenAt: number | null;
}

interface SimEvent {
  id: string;
  type: string;
  runId: string;
  agent: string;
  summary: string;
  timestamp: number;
  emailAllowed: boolean;
  host: string;
}

interface SimDelivery {
  eventId: string;
  channel: 'push' | 'email';
  acked: boolean;
}

interface SimJob {
  kind: 'email_fallback' | 'question_reminder' | 'group_close' | 'state_push';
  runAt: number;
  eventId?: string;
  runId?: string;
  questionTs?: number;
  agent?: string;
  windowStart?: number;
}

interface SimGroup {
  windowStart: number;
  count: number;
  suppressed: number;
  latestEventId: string;
  latestSummary: string;
  triggerEventId: string | null;
  closed: boolean;
}

class Sim {
  now: number;
  account: { notifyOnPhone: boolean; phoneAlertsSince: number | null; emailVerified: boolean };
  devices: SimDevice[] = [];
  events = new Map<string, SimEvent>();
  deliveries: SimDelivery[] = [];
  jobs: SimJob[] = [];
  signals: { kind: string; runId: string | null; at: number }[] = [];
  groups = new Map<string, SimGroup>();
  pushes: { eventType: string; urgency: string; deliveries: number; summary: string }[] = [];
  statePushes: { on: string; deliveries: number }[] = [];
  emails: { kind: string; delayS: number; sent: boolean }[] = [];
  stored = 0;
  duplicates = 0;
  machine: { id: string; lastHeartbeatAt: number | null; lastActiveRuns: number; alreadySilent: boolean; silent: boolean } | null = null;
  hostSilent = { created: false, alerted: false };

  constructor(input: any) {
    this.now = T(input.now);
    this.account = {
      notifyOnPhone: input.account.notify_on_phone,
      phoneAlertsSince: input.account.phone_alerts_since ? T(input.account.phone_alerts_since) : null,
      emailVerified: input.account.email_verified,
    };
    for (const d of input.devices ?? []) {
      this.devices.push({
        id: d.id,
        revokedAt: d.revoked_at ? T(d.revoked_at) : null,
        lastSeenAt: d.last_seen_at ? T(d.last_seen_at) : null,
      });
    }
    for (const s of input.signals ?? []) {
      this.signals.push({ kind: s.kind, runId: s.run_id ?? null, at: T(s.at) });
    }
    if (input.machine) {
      this.machine = {
        id: input.machine.id,
        lastHeartbeatAt: input.machine.last_heartbeat_at ? T(input.machine.last_heartbeat_at) : null,
        lastActiveRuns: input.machine.last_active_runs,
        alreadySilent: input.machine.already_silent,
        silent: input.machine.already_silent,
      };
    }
  }

  activeDeviceIds(): string[] {
    return this.devices
      .filter((d) => isDeviceActive({ revokedAt: d.revokedAt, lastSeenAt: d.lastSeenAt }, this.now))
      .map((d) => d.id);
  }

  routeState(agent: string) {
    const g = this.groups.get(agent);
    return {
      now: this.now,
      account: this.account,
      activeDeviceIds: this.activeDeviceIds(),
      group: g && !g.closed ? { windowStart: g.windowStart, count: g.count, suppressed: g.suppressed } : null,
      awayMaxHours: AWAY_MAX_HOURS,
    };
  }

  feedEvent(raw: any, index: number) {
    const ev: SimEvent = {
      id: `ev${index}`,
      type: raw.type,
      runId: raw.run_id,
      agent: raw.agent,
      summary: raw.summary,
      timestamp: T(raw.timestamp),
      emailAllowed: raw.email_allowed,
      host: raw.host ?? 'host',
    };
    // dedupe: same id (input events get synthetic ids; identical id always dup)
    for (const existing of this.events.values()) {
      const sameTuple =
        existing.runId === ev.runId &&
        existing.type === ev.type &&
        existing.summary === ev.summary &&
        Math.abs(existing.timestamp - ev.timestamp) <= 600_000;
      if (existing.id === ev.id || sameTuple) {
        this.duplicates++;
        return;
      }
    }
    this.events.set(ev.id, ev);
    this.stored++;

    const plan = route(
      {
        id: ev.id,
        type: ev.type,
        agent: ev.agent,
        runId: ev.runId,
        host: ev.host,
        summary: ev.summary,
        emailAllowed: ev.emailAllowed,
        eventTimestamp: ev.timestamp,
      },
      this.routeState(ev.agent),
    );
    this.applyPlan(ev, plan, raw.receipt_within_120s === true);
  }

  applyPlan(ev: SimEvent, plan: RoutePlan, receipt: boolean) {
    if (plan.group) {
      const g = plan.group;
      const existing = this.groups.get(ev.agent);
      if (g.action === 'create' || !existing || existing.windowStart !== g.windowStart) {
        this.groups.set(ev.agent, {
          windowStart: g.windowStart,
          count: g.count,
          suppressed: g.suppressed,
          latestEventId: g.latestEventId,
          latestSummary: g.latestSummary,
          triggerEventId: g.triggerEventId ?? null,
          closed: false,
        });
      } else {
        existing.count = g.count;
        existing.suppressed = g.suppressed;
        existing.latestEventId = g.latestEventId;
        existing.latestSummary = g.latestSummary;
        if (g.triggerEventId) existing.triggerEventId = g.triggerEventId;
      }
    }
    if (plan.pushes.length > 0) {
      this.pushes.push({
        eventType: plan.pushes[0]!.eventType,
        urgency: plan.pushes[0]!.urgency,
        deliveries: plan.pushes.length,
        summary: plan.pushes[0]!.summary,
      });
      for (const p of plan.pushes) {
        this.deliveries.push({ eventId: ev.id, channel: 'push', acked: false });
      }
      if (receipt) {
        for (const d of this.deliveries) {
          if (d.eventId === ev.id && d.channel === 'push') d.acked = true;
        }
        // A receipt on a question schedules the reminder.
        if (ev.type === 'question') {
          this.jobs.push({
            kind: 'question_reminder',
            runAt: ev.timestamp + 600_000,
            eventId: ev.id,
            runId: ev.runId,
            questionTs: ev.timestamp,
          });
        }
      }
    }
    if (plan.emailNow && plan.emailKind) {
      this.emails.push({
        kind: plan.emailKind === 'host_silent' ? 'host_silent' : 'immediate',
        delayS: 0,
        sent: true,
      });
      this.deliveries.push({ eventId: ev.id, channel: 'email', acked: false });
    }
    for (const j of plan.jobs) {
      if (j.kind === 'email_fallback') {
        this.jobs.push({ kind: 'email_fallback', runAt: j.runAt, eventId: ev.id });
      } else if (j.kind === 'group_close') {
        this.jobs.push({ kind: 'group_close', runAt: j.runAt, agent: ev.agent, windowStart: plan.group!.windowStart });
      }
    }
  }

  runJobs(upTo: number) {
    const due = this.jobs
      .filter((j) => j.runAt <= upTo)
      .sort((a, b) => a.runAt - b.runAt);
    this.jobs = this.jobs.filter((j) => j.runAt > upTo);
    for (const job of due) {
      switch (job.kind) {
        case 'email_fallback': {
          const acked = this.deliveries.some(
            (d) => d.eventId === job.eventId && d.channel === 'push' && d.acked,
          );
          if (!acked) {
            this.emails.push({ kind: 'fallback', delayS: 120, sent: true });
            this.deliveries.push({ eventId: job.eventId!, channel: 'email', acked: false });
          }
          break;
        }
        case 'question_reminder': {
          const seen = this.signals.some(
            (s) => s.kind === 'output_seen' && s.runId === job.runId && s.at >= job.questionTs!,
          );
          this.emails.push({ kind: 'reminder', delayS: 600, sent: !seen });
          break;
        }
        case 'group_close': {
          const g = this.groups.get(job.agent!);
          if (!g || g.closed) break;
          g.closed = true;
          if (g.suppressed <= 0 || !g.triggerEventId) break;
          const trigger = this.events.get(g.triggerEventId)!;
          const latest = this.events.get(g.latestEventId)!;
          const summary = `${g.count} events from ${job.agent} in the last minute; ${g.suppressed} not shown individually`;
          const plan = tableRouteForClose(
            {
              id: latest.id,
              type: latest.type,
              agent: latest.agent,
              runId: latest.runId,
              host: latest.host,
              summary: latest.summary,
              emailAllowed: trigger.emailAllowed,
              eventTimestamp: latest.timestamp,
            },
            this.routeState(job.agent!),
            trigger.type,
            'group_closed',
            summary,
          );
          this.applyPlan(latest, plan, false);
          break;
        }
        case 'state_push': {
          const on = this.account.notifyOnPhone;
          const n = this.activeDeviceIds().length;
          if (n > 0) this.statePushes.push({ on: String(on), deliveries: n });
          break;
        }
      }
    }
  }

  feedSignal(raw: any) {
    const s = { kind: raw.kind, runId: raw.run_id ?? null, at: T(raw.at), idleSeconds: raw.idle_seconds };
    this.signals.push({ kind: s.kind, runId: s.runId, at: s.at });
    if (s.kind === 'input_resumed') {
      const off = shouldAutoOff(
        this.account,
        { at: s.at, idleSeconds: s.idleSeconds ?? 0 },
        300,
      );
      if (off) {
        this.account.notifyOnPhone = false;
        const n = this.activeDeviceIds().length;
        if (n > 0) this.statePushes.push({ on: 'false', deliveries: n });
      }
    }
  }

  silenceCheck() {
    const m = this.machine;
    if (!m) return;
    if (!isSilent(m.lastHeartbeatAt, this.now)) return;
    if (m.alreadySilent) {
      m.silent = true;
      return;
    }
    m.silent = true;
    if (m.lastActiveRuns > 0) {
      this.hostSilent.created = true;
      this.hostSilent.alerted = true;
      const ev: SimEvent = {
        id: 'hs1',
        type: 'host_silent',
        runId: 'none',
        agent: 'agentwatch',
        summary: `${m.id} has stopped reporting.`,
        timestamp: this.now,
        emailAllowed: true,
        host: m.id,
      };
      this.events.set(ev.id, ev);
      this.stored++;
      const plan = route(
        {
          id: ev.id,
          type: 'host_silent',
          agent: ev.agent,
          runId: ev.runId,
          host: ev.host,
          summary: ev.summary,
          emailAllowed: true,
          eventTimestamp: ev.timestamp,
        },
        this.routeState('agentwatch'),
      );
      this.applyPlan(ev, plan, false);
    }
  }

  tick() {
    this.silenceCheck();
    if (hardCapExceeded(this.account, this.now, AWAY_MAX_HOURS)) {
      this.account.notifyOnPhone = false;
      const n = this.activeDeviceIds().length;
      if (n > 0) this.statePushes.push({ on: 'false', deliveries: n });
    }
    this.runJobs(this.now);
  }
}

interface Expected {
  pushes?: { event_type: string; urgency: string; deliveries: number; summary_pattern?: string }[];
  state_pushes?: { on: string; deliveries: number }[];
  emails?: { kind: string; delay_s: number; sent: boolean }[];
  stored?: number;
  duplicates?: number;
  notify_on_phone?: boolean;
  device_active?: boolean;
  machine_silent?: boolean;
  host_silent?: { created: boolean; alerted: boolean };
  error?: { status: number; code: string };
}

function runCase(input: any): { sim: Sim; error?: { status: number; code: string } } {
  const sim = new Sim(input);
  const trigger = input.trigger;
  let error: { status: number; code: string } | undefined;

  switch (trigger.kind) {
    case 'events': {
      (input.events ?? []).forEach((e: any, i: number) => sim.feedEvent(e, i));
      const upTo = trigger.advance_to ? T(trigger.advance_to) : Number.MAX_SAFE_INTEGER;
      if (trigger.advance_to) sim.now = T(trigger.advance_to);
      sim.runJobs(upTo);
      break;
    }
    case 'signal': {
      (input.signals ?? []).forEach((s: any) => sim.feedSignal(s));
      break;
    }
    case 'tick': {
      sim.tick();
      break;
    }
    case 'silence_check': {
      sim.silenceCheck();
      break;
    }
    case 'http': {
      // Model the endpoint contract for account actions.
      if (!sim.account.emailVerified) {
        error = { status: 403, code: 'email_not_verified' };
      } else if (trigger.path === '/api/me/notifications' && trigger.method === 'PUT') {
        const enabled = trigger.body?.enabled === true;
        sim.account.notifyOnPhone = enabled;
        if (enabled) sim.account.phoneAlertsSince = sim.now;
        const n = sim.activeDeviceIds().length;
        if (n > 0) sim.statePushes.push({ on: String(enabled), deliveries: n });
      }
      break;
    }
  }
  return { sim, ...(error !== undefined ? { error } : {}) };
}

/**
 * Known fixture/SPEC.md conflict (recorded in NOTES.md):
 * `grouping_sixth_event` expects `emails: []`, but its third event is a
 * `question` with `receipt_within_120s: true`. SPEC.md requires a receipt on a
 * question to schedule the +10min reminder email, which then fires (no
 * output_seen signal exists). Per spec/conformance/README.md, SPEC.md wins
 * over fixtures — so for this one case we assert the SPEC.md behavior
 * (reminder scheduled and sent) instead of the fixture's `emails: []`.
 */
const SPEC_WINS = new Set(['grouping_sixth_event']);

describe('routing-cases.json conformance', () => {
  for (const c of cases as any[]) {
    it(c.name, () => {
      const { sim, error } = runCase(c.input);
      const exp: Expected = c.expected;

      if (exp.pushes !== undefined) {
        expect(
          sim.pushes.map((p) => ({
            event_type: p.eventType,
            urgency: p.urgency,
            deliveries: p.deliveries,
          })),
        ).toEqual(
          exp.pushes.map((p) => ({
            event_type: p.event_type,
            urgency: p.urgency,
            deliveries: p.deliveries,
          })),
        );
        exp.pushes.forEach((p, i) => {
          if (p.summary_pattern) {
            expect(sim.pushes[i]?.summary ?? '', `summary_pattern ${c.name}`).toContain(
              p.summary_pattern,
            );
          }
        });
      }
      if (exp.state_pushes !== undefined) {
        expect(sim.statePushes).toEqual(exp.state_pushes.map((s) => ({ on: s.on, deliveries: s.deliveries })));
      }
      if (exp.emails !== undefined) {
        if (SPEC_WINS.has(c.name)) {
          // SPEC.md: receipt on the question schedules a reminder; it fires
          // because no output_seen exists for run_id r3.
          expect(sim.emails).toEqual([{ kind: 'reminder', delayS: 600_000 / 1000, sent: true }]);
        } else {
          expect(
            sim.emails.map((e) => ({ kind: e.kind, delay_s: e.delayS, sent: e.sent })),
          ).toEqual(exp.emails);
        }
      }
      if (exp.stored !== undefined) expect(sim.stored).toBe(exp.stored);
      if (exp.duplicates !== undefined) expect(sim.duplicates).toBe(exp.duplicates);
      if (exp.notify_on_phone !== undefined) {
        expect(sim.account.notifyOnPhone).toBe(exp.notify_on_phone);
      }
      if (exp.device_active !== undefined) {
        expect(sim.activeDeviceIds().length > 0).toBe(exp.device_active);
      }
      if (exp.machine_silent !== undefined) {
        expect(sim.machine?.silent ?? false).toBe(exp.machine_silent);
      }
      if (exp.host_silent !== undefined) {
        expect(sim.hostSilent).toEqual(exp.host_silent);
      }
      if (exp.error !== undefined) {
        expect(error).toEqual(exp.error);
      }
    });
  }
});
