import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Missing required environment variable: DATABASE_URL');

const { db, sql } = createDb(url);
await migrate(db, { migrationsFolder: './drizzle' });
await sql.end();
console.log('migrations applied');
