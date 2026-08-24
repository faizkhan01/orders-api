import pg from 'pg';

import { env } from '../src/config/env.js';
import { ORDERS_SQL } from '../src/orders/orders.repository.js';

// Prints the real query plans plus the OFFSET plan for contrast -- the numbers DECISIONS.md quotes. Takes an optional user id arg; defaults to the busiest user.
const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();

try {
  const userId = process.argv[2] ?? (await busiestUserId(client));
  const { rows: countRows } = await client.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM orders WHERE user_id = $1::bigint',
    [userId],
  );
  const orderCount = Number(countRows[0]?.n ?? 0);
  const totalRows = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM orders');

  console.log(`orders table: ${Number(totalRows.rows[0]?.n ?? 0).toLocaleString()} rows`);
  console.log(`user ${userId}: ${orderCount.toLocaleString()} orders\n`);

  await explain(client, 'FIRST PAGE (what the endpoint runs with no cursor)', ORDERS_SQL.firstPage, [userId, 21]);

  const midpoint = await midpointCursor(client, userId, Math.floor(orderCount / 2));
  if (midpoint) {
    await explain(client, 'PAGE N (keyset: what the endpoint runs with a cursor)', ORDERS_SQL.afterCursor, [
      userId,
      midpoint.placed_at,
      midpoint.id,
      21,
    ]);
  }

  await explain(
    client,
    `THE ALTERNATIVE: OFFSET ${Math.floor(orderCount / 2)} (not used -- for contrast)`,
    `SELECT o.id, o.placed_at FROM orders o
     WHERE o.user_id = $1::bigint
     ORDER BY o.placed_at DESC, o.id DESC
     LIMIT $2::int OFFSET $3::int`,
    [userId, 21, Math.floor(orderCount / 2)],
  );
} finally {
  await client.end();
}

async function busiestUserId(client: pg.Client): Promise<string> {
  const { rows } = await client.query<{ user_id: string }>(
    'SELECT user_id::text AS user_id FROM orders GROUP BY user_id ORDER BY count(*) DESC LIMIT 1',
  );
  if (!rows[0]) throw new Error('No orders found. Run `npm run db:setup` first.');
  return rows[0].user_id;
}

async function midpointCursor(
  client: pg.Client,
  userId: string,
  offset: number,
): Promise<{ placed_at: string; id: string } | undefined> {
  const { rows } = await client.query<{ placed_at: string; id: string }>(
    `SELECT to_char(placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS placed_at, id::text AS id
     FROM orders WHERE user_id = $1::bigint
     ORDER BY placed_at DESC, id DESC OFFSET $2::int LIMIT 1`,
    [userId, offset],
  );
  return rows[0];
}

async function explain(client: pg.Client, label: string, sql: string, params: unknown[]): Promise<void> {
  const { rows } = await client.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN (ANALYZE, BUFFERS, SUMMARY) ${sql}`,
    params,
  );
  console.log(`── ${label} ${'─'.repeat(Math.max(0, 72 - label.length))}`);
  for (const row of rows) console.log(`   ${row['QUERY PLAN']}`);
  console.log();
}
