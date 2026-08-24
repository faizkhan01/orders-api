import { env } from '../src/config/env.js';
import { applySchema, ensureDatabase } from './database.js';

await ensureDatabase(env.DATABASE_URL);
await applySchema(env.DATABASE_URL);
console.log('schema applied');
