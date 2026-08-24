import { z } from 'zod';

import { env } from '../config/env.js';
import { badRequest, type FieldIssue } from '../http/errors.js';
import { decodeCursor, MAX_BIGINT, type OrderCursor } from './cursor.js';

// Validated as a decimal string, not parsed into a number (loses precision past 2^53); leading zeros are rejected, not stripped, since requireSelfOrAdmin compares this to the token's sub.
const USER_ID_PATTERN = /^[1-9]\d{0,18}$/;

const userIdSchema = z.string().superRefine((value, ctx) => {
  if (!USER_ID_PATTERN.test(value)) {
    ctx.addIssue({ code: 'custom', message: 'must be a positive integer without leading zeros' });
    // Load-bearing return: without it, BigInt(value) below still runs on non-digit input and throws.
    return;
  }
  if (BigInt(value) > MAX_BIGINT) {
    ctx.addIssue({ code: 'custom', message: 'is out of range for a user id' });
  }
});

// Accepts the raw Express param type (string | string[] | undefined) rather than casting it away.
export function parseUserIdParam(raw: string | string[] | undefined): string {
  const parsed = userIdSchema.safeParse(typeof raw === 'string' ? raw : '');
  if (!parsed.success) {
    throw badRequest('The user id in the path is not valid.', toIssues(parsed.error, 'id'));
  }
  return parsed.data;
}

// strictObject rejects unknown params -- a silently-ignored typo like `?curser=` looks like a server bug.
const listOrdersQuerySchema = z.strictObject({
  limit: z.coerce
    .number({ error: 'must be a number' })
    .int('must be an integer')
    .min(1, 'must be at least 1')
    .max(env.ORDERS_MAX_PAGE_SIZE, `must not exceed ${env.ORDERS_MAX_PAGE_SIZE}`)
    .default(env.ORDERS_DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
});

export interface ListOrdersQuery {
  readonly limit: number;
  readonly cursor?: OrderCursor;
}

export function parseListOrdersQuery(raw: unknown): ListOrdersQuery {
  const parsed = listOrdersQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest('The query parameters are not valid.', toIssues(parsed.error));
  }

  // Out-of-range limit is a 400, not a silent clamp -- clamping hides the mistake from the caller.
  return {
    limit: parsed.data.limit,
    ...(parsed.data.cursor === undefined ? {} : { cursor: decodeCursor(parsed.data.cursor) }),
  };
}

function toIssues(error: z.ZodError, fallbackField?: string): readonly FieldIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : (fallbackField ?? '(query)'),
    message: issue.message,
  }));
}
