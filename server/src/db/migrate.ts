import { migrate } from './client.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required (e.g. mongodb://localhost:27017/agentwatch)');
  process.exit(1);
}
await migrate(url);
console.log('collections and indexes ensured');
