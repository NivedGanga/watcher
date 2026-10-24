import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// `self` for shared service-worker code paths under jsdom.
if (typeof globalThis.self === 'undefined') {
  (globalThis as Record<string, unknown>).self = globalThis;
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  cleanup();
  consoleSpies.forEach((s) => s.mockRestore());
  consoleSpies = [];
});

// Every console.* call argument, flattened, for secret-leak assertions.
export function consoleOutput(): string {
  return consoleSpies
    .flatMap((s) => s.mock.calls)
    .map((args) => args.map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    .join('\n');
}
