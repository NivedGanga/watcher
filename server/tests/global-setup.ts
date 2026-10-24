import { createDb } from '../src/db/client.js';
import { ensureIndexes } from '../src/db/indexes.js';

export default async function setup() {
  const url =
    process.env.DATABASE_URL ??
    'mongodb://localhost:27017/agentwatch_test?replicaSet=rs0&directConnection=true';
  const { db, client } = createDb(url);
  await ensureIndexes(db.db);
  await client.close();
}
