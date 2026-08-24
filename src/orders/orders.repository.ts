import type pg from 'pg';

import { pool } from '../db/pool.js';
import type { OrderCursor } from './cursor.js';

// The only file that knows SQL -- so a different real schema is a one-file change, not a rewrite.

export interface OrderRow {
  /** bigint, kept as a string. See src/db/pool.ts. */
  readonly id: string;
  readonly status: string;
  readonly total_cents: string;
  readonly currency: string;
  /** ISO-8601 UTC with microseconds, rendered by Postgres. See ./cursor.ts. */
  readonly placed_at: string;
}

// placed_at is rendered by to_char() in SQL, never a JS Date (would truncate the cursor's microsecond precision); AT TIME ZONE 'UTC' makes it session-independent.
const SELECT_COLUMNS = `
    o.id::text        AS id,
    o.status          AS status,
    o.total_cents::text AS total_cents,
    o.currency        AS currency,
    to_char(o.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS placed_at`;

// First page: an index range scan stopped by LIMIT, cost independent of how many orders the user has.
const LIST_FIRST_PAGE_SQL = `
  SELECT${SELECT_COLUMNS}
  FROM orders o
  WHERE o.user_id = $1::bigint
  ORDER BY o.placed_at DESC, o.id DESC
  LIMIT $2::int`;

// Subsequent pages: the row-comparison becomes an index condition (unlike OFFSET, which walks and discards every skipped row) and stays correct under concurrent writes.
const LIST_AFTER_CURSOR_SQL = `
  SELECT${SELECT_COLUMNS}
  FROM orders o
  WHERE o.user_id = $1::bigint
    AND (o.placed_at, o.id) < ($2::timestamptz, $3::bigint)
  ORDER BY o.placed_at DESC, o.id DESC
  LIMIT $4::int`;

// Two literal statements, not one with `$2 IS NULL OR ...` -- a NULL-guarded predicate isn't a usable index bound and lets the planner fall back to scanning + sorting.
export const ORDERS_SQL = {
  firstPage: LIST_FIRST_PAGE_SQL,
  afterCursor: LIST_AFTER_CURSOR_SQL,
} as const;

export interface OrdersRepository {
  findOrdersByUserId(params: {
    userId: string;
    /** Rows to fetch. The service asks for one more than the page size. */
    limit: number;
    cursor?: OrderCursor | undefined;
  }): Promise<readonly OrderRow[]>;

  userExists(userId: string): Promise<boolean>;
}

/** A narrow slice of pg.Pool, so tests can substitute a stub without one. */
export type Queryable = Pick<pg.Pool, 'query'>;

export function createOrdersRepository(db: Queryable = pool): OrdersRepository {
  return {
    async findOrdersByUserId({ userId, limit, cursor }) {
      const { rows } = cursor
        ? await db.query<OrderRow>(LIST_AFTER_CURSOR_SQL, [userId, cursor.placedAt, cursor.id, limit])
        : await db.query<OrderRow>(LIST_FIRST_PAGE_SQL, [userId, limit]);
      return rows;
    },

    // SELECT 1, not SELECT *: the answer is the row count, nothing else needs decoding.
    async userExists(userId) {
      const { rowCount } = await db.query('SELECT 1 FROM users WHERE id = $1::bigint', [userId]);
      return (rowCount ?? 0) > 0;
    },
  };
}
