import { z } from 'zod';

import { invalidCursor } from '../http/errors.js';

// The keyset cursor: "the last row of the previous page", as (placed_at, id). The id breaks ties on placed_at (not unique); the timestamp stays a string since Date would truncate the microsecond precision Postgres stores.
export interface OrderCursor {
  /** ISO-8601 UTC, microsecond precision: 2026-08-24T10:11:12.123456Z */
  readonly placedAt: string;
  /** orders.id as a decimal string (bigint). */
  readonly id: string;
}

/** Exactly the format the repository emits. Anything else is a bad cursor. */
const PLACED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Largest value a Postgres bigint can hold; orders.schema.ts imports this for the same reason. */
export const MAX_BIGINT = 9_223_372_036_854_775_807n;

const ID_PATTERN = /^[1-9]\d{0,18}$/;

// superRefine, not .regex().refine(): a chained refine still runs on a regex failure, so BigInt() would throw a SyntaxError past validation into a 500.
const idSchema = z.string().superRefine((value, ctx) => {
  if (!ID_PATTERN.test(value)) {
    ctx.addIssue({ code: 'custom', message: 'must be a positive integer' });
    return;
  }
  if (BigInt(value) > MAX_BIGINT) {
    ctx.addIssue({ code: 'custom', message: 'is out of range' });
  }
});

const CURSOR_VERSION = 1;

const payloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  t: z.string().regex(PLACED_AT),
  i: idSchema,
});

export function encodeCursor(cursor: OrderCursor): string {
  const payload = { v: CURSOR_VERSION, t: cursor.placedAt, i: cursor.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

// Decoded and validated, since both fields become SQL parameters. Not signed: it only narrows a range within an already-authorized user id.
export function decodeCursor(raw: string): OrderCursor {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }

  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) {
    throw invalidCursor();
  }

  return { placedAt: parsed.data.t, id: parsed.data.i };
}
