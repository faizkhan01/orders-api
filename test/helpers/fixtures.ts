import { pool } from '../../src/db/pool.js';

// Small, explicit fixtures -- the 50,000-row seed is for measuring plans, not for tests to assert on.

export interface OrderSpec {
  /** ISO-8601 UTC, microseconds allowed: '2026-01-01T00:00:00.000001Z'. */
  placedAt: string;
  status?: string;
  totalCents?: number;
  currency?: string;
}

export async function resetDatabase(): Promise<void> {
  await pool.query('TRUNCATE users, orders, order_items RESTART IDENTITY CASCADE');
}

export async function createUser(
  options: { email?: string; role?: 'customer' | 'admin'; fullName?: string } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, full_name, role) VALUES ($1, $2, $3) RETURNING id::text AS id`,
    [
      options.email ?? `user-${Math.random().toString(36).slice(2, 10)}@example.com`,
      options.fullName ?? 'Test User',
      options.role ?? 'customer',
    ],
  );
  return rows[0]!.id;
}

/** Inserts orders in the given sequence and returns their ids, in that order. */
export async function createOrders(userId: string, specs: readonly OrderSpec[]): Promise<string[]> {
  const ids: string[] = [];
  for (const spec of specs) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO orders (user_id, status, total_cents, currency, placed_at)
       VALUES ($1::bigint, $2, $3, $4, $5::timestamptz)
       RETURNING id::text AS id`,
      [userId, spec.status ?? 'paid', spec.totalCents ?? 1_999, spec.currency ?? 'USD', spec.placedAt],
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

/** `count` orders, one minute apart, newest last -- so the expected response is the reverse. */
export async function createOrderSeries(userId: string, count: number, startIso = '2026-01-01T00:00:00.000000Z') {
  const start = Date.parse(startIso);
  const specs: OrderSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    specs.push({ placedAt: new Date(start + i * 60_000).toISOString().replace('Z', '000Z') });
  }
  return createOrders(userId, specs);
}

/** An id that is syntactically valid and certainly absent. */
export const MISSING_USER_ID = '999999999';
