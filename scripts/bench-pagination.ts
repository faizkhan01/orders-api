import pg from 'pg';

import { env } from '../src/config/env.js';

// Measures keyset vs OFFSET at increasing page depth, inside a rolled-back transaction -- safe to run against the seeded database. See README.md for usage.
const ORDER_COUNT = Number(process.argv[2] ?? 200_000);
const PAGE_SIZE = 21; // what the service asks for at the default limit of 20

const KEYSET_SQL = `
  SELECT o.id FROM orders o
  WHERE o.user_id = $1::bigint
    AND (o.placed_at, o.id) < ($2::timestamptz, $3::bigint)
  ORDER BY o.placed_at DESC, o.id DESC
  LIMIT ${PAGE_SIZE}`;

const OFFSET_SQL = `
  SELECT o.id FROM orders o
  WHERE o.user_id = $1::bigint
  ORDER BY o.placed_at DESC, o.id DESC
  LIMIT ${PAGE_SIZE} OFFSET $2::int`;

const client = new pg.Client({ connectionString: env.DATABASE_URL, statement_timeout: 120_000 });
await client.connect();
await client.query('BEGIN');

try {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (email, full_name) VALUES ('bench-${Date.now()}@example.invalid', 'Bench')
     RETURNING id::text AS id`,
  );
  const userId = rows[0]!.id;

  process.stdout.write(`inserting ${ORDER_COUNT.toLocaleString()} orders... `);
  await client.query(
    `INSERT INTO orders (user_id, status, total_cents, currency, placed_at)
     SELECT $1::bigint, 'paid', 1000, 'USD', now() - (g || ' seconds')::interval
     FROM generate_series(1, $2::int) g`,
    [userId, ORDER_COUNT],
  );
  await client.query('ANALYZE orders'); // otherwise the planner still thinks this user has ~10 orders
  console.log('done\n');

  console.log(`page depth        keyset      OFFSET   rows read by OFFSET`);
  console.log(`${'-'.repeat(62)}`);

  for (const depth of [0, 100, 10_000, 100_000, ORDER_COUNT - PAGE_SIZE]) {
    const cursor = await cursorAtDepth(client, userId, depth);
    const keyset = cursor ? await median(() => client.query(KEYSET_SQL, [userId, cursor.t, cursor.id])) : NaN;
    const offset = await median(() => client.query(OFFSET_SQL, [userId, depth]));
    const scanned = depth + PAGE_SIZE; // OFFSET's cost: rows read and discarded
    console.log(
      `${depth.toLocaleString().padStart(10)}  ${ms(keyset).padStart(10)}  ${ms(offset).padStart(10)}  ${scanned.toLocaleString().padStart(20)}`,
    );
  }
} finally {
  await client.query('ROLLBACK'); // leaves the database exactly as it was found
  await client.end();
}

async function cursorAtDepth(
  client: pg.Client,
  userId: string,
  depth: number,
): Promise<{ t: string; id: string } | undefined> {
  if (depth === 0) return undefined;
  const { rows } = await client.query<{ t: string; id: string }>(
    `SELECT to_char(placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t, id::text AS id
     FROM orders WHERE user_id = $1::bigint
     ORDER BY placed_at DESC, id DESC OFFSET $2::int LIMIT 1`,
    [userId, depth],
  );
  return rows[0];
}

function ms(value: number): string {
  return Number.isNaN(value) ? '-' : `${value.toFixed(2)}ms`;
}

/** Median of five, to keep one unlucky run from being the headline. */
async function median(run: () => Promise<unknown>): Promise<number> {
  const timings: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const startedAt = process.hrtime.bigint();
    await run();
    timings.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
  timings.sort((a, b) => a - b);
  return timings[2]!;
}
