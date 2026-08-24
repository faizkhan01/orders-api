import pg from 'pg';

import { env } from '../config/env.js';
import { logger } from '../logger.js';

const { Pool } = pg;

// bigint arrives from pg as a string; kept that way everywhere (params, cursors, JSON) to avoid silently corrupting ids above 2^53.

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX,
  connectionTimeoutMillis: env.PG_CONNECTION_TIMEOUT_MS,
  // Reap idle connections so a traffic spike doesn't pin the pool at max forever.
  idleTimeoutMillis: 30_000,
  // Connection-level timeouts, not `pool.on('connect')` + `SET`, which races the first query.
  statement_timeout: env.PG_STATEMENT_TIMEOUT_MS,
  query_timeout: env.PG_STATEMENT_TIMEOUT_MS,
  // Nothing here should hold a transaction open; an idle one blocks VACUUM.
  idle_in_transaction_session_timeout: 10_000,
  application_name: 'orders-api',
});

// An idle client can die between requests; an unhandled 'error' event here would crash the process.
pool.on('error', (error) => {
  logger.error({ err: error }, 'idle postgres client errored');
});

/** Liveness of the dependency, for /readyz. */
export async function pingDatabase(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closePool(): Promise<void> {
  await pool.end();
}
