import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { closePool } from '../src/db/pool.js';
import { encodeCursor } from '../src/orders/cursor.js';
import { createOrderSeries, createOrders, createUser, MISSING_USER_ID, resetDatabase } from './helpers/fixtures.js';

let app: Express;

const bearer = (userId: string, role: 'customer' | 'admin' = 'customer', expiresIn?: string) =>
  `Bearer ${signAccessToken({ userId, role, ...(expiresIn ? { expiresIn } : {}) })}`;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('authentication', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await request(app).get('/api/users/1/orders');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a non-Bearer Authorization header', async () => {
    const res = await request(app).get('/api/users/1/orders').set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    // Signed with a different key; header and claims are otherwise perfect.
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJyb2xlIjoiYWRtaW4iLCJzdWIiOiIxIiwiaXNzIjoib3JkZXJzLWFwaSIsImF1ZCI6Im9yZGVycy1hcGkifQ.' +
      'not-a-valid-signature';
    const res = await request(app).get('/api/users/1/orders').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('rejects an expired token, and says so', async () => {
    const userId = await createUser();
    const res = await request(app)
      .get(`/api/users/${userId}/orders`)
      .set('Authorization', bearer(userId, 'customer', '-10m'));
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/expired/i);
  });
});

describe('authorization', () => {
  it('lets a user read their own orders', async () => {
    const userId = await createUser();
    const res = await request(app).get(`/api/users/${userId}/orders`).set('Authorization', bearer(userId));
    expect(res.status).toBe(200);
  });

  it("forbids a customer from reading another user's orders", async () => {
    const [alice, bob] = [await createUser(), await createUser()];
    const res = await request(app).get(`/api/users/${bob}/orders`).set('Authorization', bearer(alice));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lets an admin read another user’s orders', async () => {
    const admin = await createUser({ role: 'admin' });
    const bob = await createUser();
    await createOrderSeries(bob, 3);
    const res = await request(app).get(`/api/users/${bob}/orders`).set('Authorization', bearer(admin, 'admin'));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });

  // The enumeration test: a missing user id must get the same 403 as a real one, or user ids become testable.
  it('returns 403, not 404, when a customer asks about a non-existent user', async () => {
    const alice = await createUser();
    const res = await request(app).get(`/api/users/${MISSING_USER_ID}/orders`).set('Authorization', bearer(alice));
    expect(res.status).toBe(403);
  });
});

describe('results', () => {
  it('returns orders newest first', async () => {
    const userId = await createUser();
    const ids = await createOrders(userId, [
      { placedAt: '2026-01-01T00:00:00.000000Z' },
      { placedAt: '2026-03-01T00:00:00.000000Z' },
      { placedAt: '2026-02-01T00:00:00.000000Z' },
    ]);
    const [jan, mar, feb] = ids;

    const res = await request(app).get(`/api/users/${userId}/orders`).set('Authorization', bearer(userId));

    expect(res.status).toBe(200);
    expect(res.body.data.map((o: { id: string }) => o.id)).toEqual([mar, feb, jan]);
  });

  it('returns 200 and an empty array for a user with no orders', async () => {
    const userId = await createUser();
    const res = await request(app).get(`/api/users/${userId}/orders`).set('Authorization', bearer(userId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [],
      pagination: { limit: 20, hasMore: false, nextCursor: null },
    });
  });

  it('returns 404 for a user that does not exist', async () => {
    const admin = await createUser({ role: 'admin' });
    const res = await request(app)
      .get(`/api/users/${MISSING_USER_ID}/orders`)
      .set('Authorization', bearer(admin, 'admin'));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('exposes money as integer minor units and timestamps at microsecond precision', async () => {
    const userId = await createUser();
    await createOrders(userId, [
      { placedAt: '2026-01-01T12:00:00.123456Z', totalCents: 123_45, currency: 'EUR', status: 'shipped' },
    ]);

    const res = await request(app).get(`/api/users/${userId}/orders`).set('Authorization', bearer(userId));

    expect(res.body.data[0]).toMatchObject({
      status: 'shipped',
      totalCents: 12_345,
      currency: 'EUR',
      placedAt: '2026-01-01T12:00:00.123456Z',
    });
  });

  it('marks per-user data as uncacheable and echoes the request id', async () => {
    const userId = await createUser();
    const res = await request(app)
      .get(`/api/users/${userId}/orders`)
      .set('Authorization', bearer(userId))
      .set('X-Request-Id', 'trace-abc-123');

    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });
});

describe('pagination', () => {
  it('walks every order exactly once across pages', async () => {
    const userId = await createUser();
    const ascending = await createOrderSeries(userId, 25);
    const expected = [...ascending].reverse(); // newest first

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const res: request.Response = await request(app)
        .get(`/api/users/${userId}/orders`)
        .query({ limit: 10, ...(cursor ? { cursor } : {}) })
        .set('Authorization', bearer(userId));

      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((o: { id: string }) => o.id));
      cursor = res.body.pagination.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10); // a cursor that never terminates is a bug
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(25);
  });

  it('reports hasMore and stops issuing a cursor on the last page', async () => {
    const userId = await createUser();
    await createOrderSeries(userId, 3);

    const first = await request(app)
      .get(`/api/users/${userId}/orders`)
      .query({ limit: 2 })
      .set('Authorization', bearer(userId));
    expect(first.body.pagination).toMatchObject({ limit: 2, hasMore: true });
    expect(first.body.pagination.nextCursor).toBeTypeOf('string');

    const second = await request(app)
      .get(`/api/users/${userId}/orders`)
      .query({ limit: 2, cursor: first.body.pagination.nextCursor })
      .set('Authorization', bearer(userId));
    expect(second.body.data).toHaveLength(1);
    expect(second.body.pagination).toMatchObject({ hasMore: false, nextCursor: null });
  });

  // Why the cursor carries an id too: all eight share one placed_at, so a timestamp-only cursor would loop or skip rows.
  it('paginates correctly when every order shares the same placed_at', async () => {
    const userId = await createUser();
    const sameInstant = '2026-05-05T05:05:05.050505Z';
    const ids = await createOrders(
      userId,
      Array.from({ length: 8 }, () => ({ placedAt: sameInstant })),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await request(app)
        .get(`/api/users/${userId}/orders`)
        .query({ limit: 3, ...(cursor ? { cursor } : {}) })
        .set('Authorization', bearer(userId));
      seen.push(...res.body.data.map((o: { id: string }) => o.id));
      cursor = res.body.pagination.nextCursor;
    } while (cursor);

    // Ties break on id descending, deterministically.
    expect(seen).toEqual([...ids].reverse());
  });

  it('returns an empty page, not a 404, for a cursor past the end of the data', async () => {
    const userId = await createUser();
    await createOrderSeries(userId, 2, '2026-01-01T00:00:00.000000Z');

    const pastTheEnd = encodeCursor({ placedAt: '2000-01-01T00:00:00.000000Z', id: '1' });
    const res = await request(app)
      .get(`/api/users/${userId}/orders`)
      .query({ cursor: pastTheEnd })
      .set('Authorization', bearer(userId));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination).toMatchObject({ hasMore: false, nextCursor: null });
  });

  // Deliberate asymmetry: a cursor means the caller was already told the user exists, so an empty page wins over a 404.
  it('returns an empty page for a cursor on a user that no longer exists', async () => {
    const admin = await createUser({ role: 'admin' });
    const cursor = encodeCursor({ placedAt: '2026-01-01T00:00:00.000000Z', id: '1' });

    const res = await request(app)
      .get(`/api/users/${MISSING_USER_ID}/orders`)
      .query({ cursor })
      .set('Authorization', bearer(admin, 'admin'));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('input validation', () => {
  it.each(['abc', '0', '-1', '007', '1.5', '9999999999999999999999'])('rejects user id %j', async (id) => {
    const admin = await createUser({ role: 'admin' });
    const res = await request(app).get(`/api/users/${id}/orders`).set('Authorization', bearer(admin, 'admin'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it.each([
    ['limit=0', { limit: '0' }],
    ['limit above the maximum', { limit: '101' }],
    ['non-numeric limit', { limit: 'ten' }],
    ['unknown parameter', { page: '2' }],
    ['misspelled cursor', { curser: 'abc' }],
    ['empty cursor', { cursor: '' }],
    ['repeated limit', { limit: ['5', '10'] }],
  ] as const)('rejects %s', async (_label, query) => {
    const userId = await createUser();
    const res = await request(app)
      .get(`/api/users/${userId}/orders`)
      .query(query)
      .set('Authorization', bearer(userId));
    expect(res.status).toBe(400);
  });

  it('rejects a cursor that is not one this service issued', async () => {
    const userId = await createUser();
    for (const cursor of ['not-base64', Buffer.from('{}').toString('base64url')]) {
      const res = await request(app)
        .get(`/api/users/${userId}/orders`)
        .query({ cursor })
        .set('Authorization', bearer(userId));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    }
  });

  it('rejects a cursor whose timestamp has been tampered with', async () => {
    const userId = await createUser();
    const tampered = Buffer.from(JSON.stringify({ v: 1, t: "2026-01-01'; DROP TABLE orders --", i: '1' })).toString(
      'base64url',
    );
    const res = await request(app)
      .get(`/api/users/${userId}/orders`)
      .query({ cursor: tampered })
      .set('Authorization', bearer(userId));

    expect(res.status).toBe(400);
    // And the table is still there, because the value never reached SQL as text.
    const stillThere = await request(app).get(`/api/users/${userId}/orders`).set('Authorization', bearer(userId));
    expect(stillThere.status).toBe(200);
  });
});

describe('operational endpoints', () => {
  it('reports liveness without touching the database', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('reports readiness based on the database', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('ok');
  });

  it('reports 503 from /readyz when the database is unreachable', async () => {
    const degraded = createApp({
      checkDatabase: () => Promise.reject(new Error('connection refused')),
    });
    const res = await request(degraded).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
  });

  it('returns the standard error envelope for an unknown route', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.requestId).toBeTypeOf('string');
  });
});
