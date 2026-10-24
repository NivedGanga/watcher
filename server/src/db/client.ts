import { MongoClient, type ClientSession, type Db as MongoDb } from 'mongodb';
import { ensureIndexes } from './indexes.js';

/**
 * A query handle: the shared database (outside a transaction) or a
 * transaction-bound view. Every repo function takes this; `session` is set
 * only inside `transaction()` callbacks.
 */
export interface Q {
  db: MongoDb;
  session?: ClientSession;
}

/**
 * MongoDB-backed database handle. `transaction()` mirrors the drizzle call
 * signature used across routes: the callback receives a `Q` bound to a
 * session. The driver's withTransaction retries the callback on
 * TransientTransactionError, so write conflicts on locked documents
 * serialize like `SELECT ... FOR UPDATE` did under Postgres.
 */
export class Database implements Q {
  readonly session?: ClientSession;

  constructor(
    public readonly client: MongoClient,
    public readonly db: MongoDb,
  ) {}

  async transaction<T>(fn: (tx: Q) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      let out!: T;
      await session.withTransaction(async () => {
        out = await fn({ db: this.db, session });
      });
      return out;
    } finally {
      await session.endSession();
    }
  }
}

export type Db = Database;

export function createDb(databaseUrl: string): { db: Database; client: MongoClient } {
  const client = new MongoClient(databaseUrl, { maxPoolSize: 10 });
  // Lazy connect: the driver connects on first operation.
  const db = new Database(client, client.db());
  return { db, client };
}

/** Create collections and indexes. Idempotent; run at deploy time and dev boot. */
export async function migrate(databaseUrl: string): Promise<void> {
  const client = new MongoClient(databaseUrl);
  await client.connect();
  try {
    await ensureIndexes(client.db());
  } finally {
    await client.close();
  }
}
