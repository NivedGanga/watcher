import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from '../src/db/client.js';

export default async function setup() {
  const url =
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5433/agentwatch_test';
  const { db, sql } = createDb(url);
  await migrate(db, { migrationsFolder: './drizzle' });
  await sql.end();
}
