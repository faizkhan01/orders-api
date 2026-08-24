import { describe, expect, it } from 'vitest';

import { AppError } from '../src/http/errors.js';
import { decodeCursor, encodeCursor } from '../src/orders/cursor.js';

describe('cursor codec', () => {
  it('round-trips a cursor without losing microseconds', () => {
    const cursor = { placedAt: '2026-08-24T10:11:12.123456Z', id: '9007199254740993' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  // 9007199254740993 is Number.MAX_SAFE_INTEGER + 2 -- parsed into a number it'd come back as ...992.
  it('preserves an id beyond Number.MAX_SAFE_INTEGER', () => {
    const id = '9007199254740993';
    expect(Number(id).toString()).not.toBe(id); // the trap being avoided
    expect(decodeCursor(encodeCursor({ placedAt: '2026-01-01T00:00:00.000000Z', id })).id).toBe(id);
  });

  it('produces a URL-safe token', () => {
    const encoded = encodeCursor({ placedAt: '2026-08-24T10:11:12.123456Z', id: '42' });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });

  describe('rejects', () => {
    const cases: Record<string, string> = {
      'a non-base64 string': 'not a cursor',
      'valid base64 that is not JSON': Buffer.from('hello').toString('base64url'),
      'JSON that is not an object': Buffer.from('[1,2,3]').toString('base64url'),
      'a missing version': Buffer.from(JSON.stringify({ t: '2026-01-01T00:00:00.000000Z', i: '1' })).toString(
        'base64url',
      ),
      'a future version': Buffer.from(
        JSON.stringify({ v: 2, t: '2026-01-01T00:00:00.000000Z', i: '1' }),
      ).toString('base64url'),
      // Bound to a ::timestamptz parameter; unparseable there is a 500.
      'a malformed timestamp': Buffer.from(JSON.stringify({ v: 1, t: 'yesterday', i: '1' })).toString('base64url'),
      // Milliseconds only -- not a format this service emits.
      'a truncated timestamp': Buffer.from(
        JSON.stringify({ v: 1, t: '2026-01-01T00:00:00.000Z', i: '1' }),
      ).toString('base64url'),
      'a non-numeric id': Buffer.from(
        JSON.stringify({ v: 1, t: '2026-01-01T00:00:00.000000Z', i: '1 OR 1=1' }),
      ).toString('base64url'),
      'a zero id': Buffer.from(JSON.stringify({ v: 1, t: '2026-01-01T00:00:00.000000Z', i: '0' })).toString(
        'base64url',
      ),
      // 19 digits passes the shape regex but exceeds Postgres bigint max; must be a 400, not a 500.
      'an id past the bigint max': Buffer.from(
        JSON.stringify({ v: 1, t: '2026-01-01T00:00:00.000000Z', i: '9999999999999999999' }),
      ).toString('base64url'),
    };

    for (const [label, value] of Object.entries(cases)) {
      it(label, () => {
        expect(() => decodeCursor(value)).toThrowError(
          expect.objectContaining({ code: 'INVALID_CURSOR', status: 400 }),
        );
        // A bad cursor is the caller's mistake, never a 500.
        try {
          decodeCursor(value);
        } catch (error) {
          expect(error).toBeInstanceOf(AppError);
          expect((error as AppError).expected).toBe(true);
        }
      });
    }
  });
});
