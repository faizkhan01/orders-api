import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));

// Creates the target database via the `postgres` maintenance database; the name is escaped as an identifier since CREATE DATABASE can't take a bind parameter.
export async function ensureDatabase(connectionString: string): Promise<void> {
  const url = new URL(connectionString);
  const targetName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!targetName) {
    throw new Error(`DATABASE_URL has no database name: ${connectionString}`);
  }

  const adminUrl = new URL(url.toString());
  adminUrl.pathname = '/postgres';

  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetName]);
    if ((rowCount ?? 0) === 0) {
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(targetName)}`);
      console.log(`created database "${targetName}"`);
    }
  } catch (error) {
    // Two processes racing here is normal and harmless -- one wins, the other sees 42P04.
    if (!isDuplicateDatabase(error)) throw error;
  } finally {
    await client.end();
  }
}

function isDuplicateDatabase(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '42P04';
}

// db/schema.sql is idempotent, so applying it on every boot is safe and needs no migration tool at this size.
export async function applySchema(connectionString: string): Promise<void> {
  const sql = await readFile(join(HERE, 'schema.sql'), 'utf8');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
