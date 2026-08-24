import { applySchema, ensureDatabase } from '../db/database.js';
import { resolveTestDatabaseUrl } from './test-env.js';

// Creates the test database and applies the real schema before any test runs -- tests go through real Postgres, not a mock of one.
export default async function setup(): Promise<void> {
  const url = resolveTestDatabaseUrl();
  await ensureDatabase(url);
  await applySchema(url);
}
