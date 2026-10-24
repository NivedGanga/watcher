import { describe, expect, it } from 'vitest';
import { nextFlagState, type FlagState, type StateData } from '../src/shared/awsw';

const msg = (timestamp: string, on: 'true' | 'false' = 'true', until = ''): StateData => ({
  type: 'state',
  on,
  until,
  timestamp,
});

describe('flag state reducer', () => {
  it('applies a strictly newer timestamp', () => {
    const current: FlagState = { on: false, until: null, timestamp: '2026-01-01T00:00:00Z' };
    const next = nextFlagState(current, msg('2026-01-01T01:00:00Z', 'true', '2026-01-01T09:00:00Z'));
    expect(next).toEqual({ on: true, until: '2026-01-01T09:00:00Z', timestamp: '2026-01-01T01:00:00Z' });
  });

  it('ignores an older timestamp', () => {
    const current: FlagState = { on: true, until: '2026-01-01T09:00:00Z', timestamp: '2026-01-01T02:00:00Z' };
    expect(nextFlagState(current, msg('2026-01-01T01:00:00Z'))).toBeNull();
  });

  it('ignores an equal timestamp', () => {
    const current: FlagState = { on: true, until: null, timestamp: '2026-01-01T01:00:00Z' };
    expect(nextFlagState(current, msg('2026-01-01T01:00:00Z', 'false'))).toBeNull();
  });

  it('accepts the first state', () => {
    const next = nextFlagState(undefined, msg('2026-01-01T01:00:00Z', 'false'));
    expect(next).toEqual({ on: false, until: null, timestamp: '2026-01-01T01:00:00Z' });
  });

  it('maps empty until to null', () => {
    const next = nextFlagState(undefined, msg('2026-01-01T01:00:00Z', 'true', ''));
    expect(next?.until).toBeNull();
  });
});
