import pg from 'pg';

import { env } from '../src/config/env.js';

// Seeds ~5,000 users and ~50,000 orders, deterministically (fixed-seed PRNG, not Math.random) -- see SEED_USERS below for the awkward cases it plants on purpose.

export const SEED_USERS = {
  /** role=admin: may read anyone's orders. */
  admin: { id: '1', email: 'admin@example.com' },
  /** 250 orders -- enough to walk many pages. */
  heavy: { id: '2', email: 'alice@example.com', orderCount: 250 },
  /** Zero orders: the 200-with-empty-array case. */
  empty: { id: '3', email: 'newcomer@example.com', orderCount: 0 },
  /** 8 orders, all with identical placed_at: the cursor tiebreaker case. */
  tied: { id: '4', email: 'tied@example.com', orderCount: 8 },
} as const;

const STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'] as const;
const CURRENCIES = ['USD', 'EUR', 'GBP'] as const;
const PRODUCTS = [
  'Mechanical keyboard',
  'Standing desk mat',
  'USB-C hub',
  'Noise-cancelling headphones',
  'Laptop stand',
  'Webcam cover',
  'Cable organiser',
  'Monitor arm',
] as const;

/** mulberry32: small, fast, and reproducible across Node versions. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INSERT_BATCH = 1_000;

export interface SeedOptions {
  userCount?: number;
  targetOrderCount?: number;
  seed?: number;
}

export async function seedDatabase(client: pg.ClientBase, options: SeedOptions = {}): Promise<void> {
  const userCount = options.userCount ?? 5_000;
  const targetOrderCount = options.targetOrderCount ?? 50_000;
  const random = createRandom(options.seed ?? 20260824);

  // RESTART IDENTITY keeps the ids above stable across re-seeds; CASCADE covers order_items.
  await client.query('TRUNCATE users, orders, order_items RESTART IDENTITY CASCADE');

  const userIds = await insertUsers(client, userCount);
  const orderCounts = planOrderCounts(userCount, targetOrderCount, random);
  const totalOrders = await insertOrders(client, userIds, orderCounts, random);

  console.log(`seeded ${userIds.length} users and ${totalOrders} orders`);
}

async function insertUsers(client: pg.ClientBase, userCount: number): Promise<string[]> {
  const rows: [string, string, string][] = [];

  rows.push([SEED_USERS.admin.email, 'Ada Admin', 'admin']);
  rows.push([SEED_USERS.heavy.email, 'Alice Heavy', 'customer']);
  rows.push([SEED_USERS.empty.email, 'Noah Newcomer', 'customer']);
  rows.push([SEED_USERS.tied.email, 'Tara Tied', 'customer']);

  for (let i = rows.length + 1; i <= userCount; i += 1) {
    rows.push([`user${String(i).padStart(5, '0')}@example.com`, `Customer ${i}`, 'customer']);
  }

  const ids: string[] = [];
  for (let start = 0; start < rows.length; start += INSERT_BATCH) {
    const batch = rows.slice(start, start + INSERT_BATCH);
    const values = batch.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(', ');
    // RETURNING id rather than assuming the identity sequence produced 1..N.
    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO users (email, full_name, role) VALUES ${values} RETURNING id::text AS id`,
      batch.flat(),
    );
    ids.push(...inserted.map((row) => row.id));
  }

  return ids;
}

// Shaped, not uniform: most users have a handful, a few have hundreds, so the "one hot user" failure mode in DECISIONS.md is actually observable.
function planOrderCounts(userCount: number, targetOrderCount: number, random: () => number): number[] {
  const counts = new Array<number>(userCount).fill(0);

  counts[0] = 3; // admin has a few of their own
  counts[1] = SEED_USERS.heavy.orderCount;
  counts[2] = SEED_USERS.empty.orderCount;
  counts[3] = SEED_USERS.tied.orderCount;

  const fixed = counts.slice(0, 4).reduce((sum, n) => sum + n, 0);
  let remaining = targetOrderCount - fixed;

  for (let i = 4; i < userCount && remaining > 0; i += 1) {
    const usersLeft = userCount - i;
    const average = remaining / usersLeft;
    // Long tail: ~4% of users get roughly 6x the average.
    const draw = random() < 0.04 ? Math.round(average * 6 * random()) : Math.round(average * 1.6 * random());
    const count = Math.max(0, Math.min(draw, remaining));
    counts[i] = count;
    remaining -= count;
  }

  // Leftover lands on the last user rather than being dropped, so the total matches the target exactly.
  if (remaining > 0) {
    counts[userCount - 1] = (counts[userCount - 1] ?? 0) + remaining;
  }

  return counts;
}

const THREE_YEARS_MS = 3 * 365 * 24 * 60 * 60 * 1000;

// Date.toISOString() stops at milliseconds, so this fabricates real microsecond digits for the cursor's precision to actually be exercised.
function pgTimestamp(epochMs: number, micros: number): string {
  const iso = new Date(epochMs).toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  return `${iso.slice(0, -1)}${String(micros).padStart(3, '0')}Z`;
}

async function insertOrders(
  client: pg.ClientBase,
  userIds: readonly string[],
  orderCounts: readonly number[],
  random: () => number,
): Promise<number> {
  const now = Date.now();
  type OrderTuple = [string, string, number, string, string];
  let pending: OrderTuple[] = [];
  let total = 0;

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const values = pending
      .map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5}::timestamptz)`)
      .join(', ');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO orders (user_id, status, total_cents, currency, placed_at)
       VALUES ${values} RETURNING id::text AS id`,
      pending.flat(),
    );
    await insertOrderItems(
      client,
      rows.map((row) => row.id),
      random,
    );
    total += pending.length;
    pending = [];
  };

  for (let userIndex = 0; userIndex < userIds.length; userIndex += 1) {
    const userId = userIds[userIndex];
    const count = orderCounts[userIndex] ?? 0;
    if (userId === undefined) continue;

    // The tied user's orders all share one instant, down to the microsecond.
    const tiedInstant = userId === SEED_USERS.tied.id ? pgTimestamp(now - THREE_YEARS_MS / 2, 500) : null;

    for (let n = 0; n < count; n += 1) {
      const placedAt =
        tiedInstant ??
        pgTimestamp(now - Math.floor(random() * THREE_YEARS_MS), Math.floor(random() * 1000));
      pending.push([
        userId,
        STATUSES[Math.floor(random() * STATUSES.length)] ?? 'paid',
        0, // placeholder; total_cents is derived from line items below
        CURRENCIES[Math.floor(random() * CURRENCIES.length)] ?? 'USD',
        placedAt,
      ]);
      if (pending.length >= INSERT_BATCH) await flush();
    }
  }

  await flush();

  // total_cents derived from line items in one pass, rather than guessed per row in JS.
  await client.query(`
    UPDATE orders o
    SET total_cents = COALESCE(i.sum_cents, 0)
    FROM (
      SELECT order_id, SUM(quantity * unit_cents) AS sum_cents
      FROM order_items GROUP BY order_id
    ) i
    WHERE i.order_id = o.id
  `);

  return total;
}

async function insertOrderItems(client: pg.ClientBase, orderIds: readonly string[], random: () => number) {
  type ItemTuple = [string, string, string, number, number];
  const rows: ItemTuple[] = [];

  for (const orderId of orderIds) {
    const itemCount = 1 + Math.floor(random() * 4);
    for (let i = 0; i < itemCount; i += 1) {
      const productIndex = Math.floor(random() * PRODUCTS.length);
      rows.push([
        orderId,
        `SKU-${String(productIndex + 1).padStart(3, '0')}`,
        PRODUCTS[productIndex] ?? 'Unknown product',
        1 + Math.floor(random() * 3),
        500 + Math.floor(random() * 40_000),
      ]);
    }
  }

  for (let start = 0; start < rows.length; start += INSERT_BATCH) {
    const batch = rows.slice(start, start + INSERT_BATCH);
    const values = batch
      .map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`)
      .join(', ');
    await client.query(
      `INSERT INTO order_items (order_id, sku, description, quantity, unit_cents) VALUES ${values}`,
      batch.flat(),
    );
  }
}

/** CLI entry point: `npm run db:seed`. */
async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  const startedAt = Date.now();
  try {
    // One transaction: a failed seed leaves an empty database, not a half-populated one.
    await client.query('BEGIN');
    await seedDatabase(client);
    await client.query('COMMIT');
    // Fresh statistics immediately, or the first EXPLAIN after seeding is misleading.
    await client.query('ANALYZE users, orders, order_items');
    console.log(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
