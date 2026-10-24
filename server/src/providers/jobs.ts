import type { JobRunner, DbLike } from './types.js';
import { asDb, enqueueJob } from '../repo.js';

/** Database-backed JobRunner. Self-hosted deployments could swap this out. */
export class MongoJobRunner implements JobRunner {
  constructor(private db: DbLike) {}

  async enqueue(
    kind: string,
    payload: Record<string, unknown>,
    runAt: Date,
    opts?: { dbOrTx?: DbLike; dedupeKey?: string },
  ): Promise<void> {
    await enqueueJob(asDb(opts?.dbOrTx ?? this.db), kind, payload, runAt, opts?.dedupeKey);
  }
}

export const fetchHealthCheck = {
  async ping(url: string): Promise<void> {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`healthcheck ping failed: ${res.status}`);
  },
};
