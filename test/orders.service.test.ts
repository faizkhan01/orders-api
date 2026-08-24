import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../src/http/errors.js';
import { decodeCursor } from '../src/orders/cursor.js';
import type { OrderRow, OrdersRepository } from '../src/orders/orders.repository.js';
import { createOrdersService } from '../src/orders/orders.service.js';

// Stub repository on purpose -- SQL is covered against real Postgres in orders.route.test.ts; this tests the two decisions the service makes on its own.

function row(id: string, placedAt: string): OrderRow {
  return { id, status: 'paid', total_cents: '1000', currency: 'USD', placed_at: placedAt };
}

function stubRepository(rows: OrderRow[], userExists = true) {
  const findOrdersByUserId = vi.fn<OrdersRepository['findOrdersByUserId']>(({ limit }) =>
    Promise.resolve(rows.slice(0, limit)),
  );
  const userExistsFn = vi.fn<OrdersRepository['userExists']>(() => Promise.resolve(userExists));
  return { findOrdersByUserId, userExists: userExistsFn } satisfies OrdersRepository;
}

const ts = (n: number) => `2026-01-0${n}T00:00:00.000000Z`;

describe('listUserOrders', () => {
  it('asks the repository for one row more than the page size', async () => {
    const repository = stubRepository([row('3', ts(3)), row('2', ts(2)), row('1', ts(1))]);
    const service = createOrdersService(repository);

    await service.listUserOrders({ userId: '7', query: { limit: 2 } });

    expect(repository.findOrdersByUserId).toHaveBeenCalledWith({ userId: '7', limit: 3, cursor: undefined });
  });

  it('does not leak the extra row into the response', async () => {
    const repository = stubRepository([row('3', ts(3)), row('2', ts(2)), row('1', ts(1))]);
    const service = createOrdersService(repository);

    const page = await service.listUserOrders({ userId: '7', query: { limit: 2 } });

    expect(page.data.map((o) => o.id)).toEqual(['3', '2']);
    expect(page.pagination.hasMore).toBe(true);
  });

  it('points the next cursor at the last returned row, not the extra one', async () => {
    const repository = stubRepository([row('3', ts(3)), row('2', ts(2)), row('1', ts(1))]);
    const service = createOrdersService(repository);

    const page = await service.listUserOrders({ userId: '7', query: { limit: 2 } });

    // Off by one here silently skips a row on every page boundary.
    expect(decodeCursor(page.pagination.nextCursor!)).toEqual({ placedAt: ts(2), id: '2' });
  });

  it('reports the last page with no cursor when the extra row is absent', async () => {
    const repository = stubRepository([row('2', ts(2)), row('1', ts(1))]);
    const service = createOrdersService(repository);

    const page = await service.listUserOrders({ userId: '7', query: { limit: 5 } });

    expect(page.data).toHaveLength(2);
    expect(page.pagination).toEqual({ limit: 5, hasMore: false, nextCursor: null });
  });

  it('does not check user existence when rows came back', async () => {
    const repository = stubRepository([row('1', ts(1))]);
    const service = createOrdersService(repository);

    await service.listUserOrders({ userId: '7', query: { limit: 20 } });

    // The common path must stay at one query.
    expect(repository.userExists).not.toHaveBeenCalled();
  });

  it('returns an empty page for a user who exists but has never ordered', async () => {
    const repository = stubRepository([], true);
    const service = createOrdersService(repository);

    const page = await service.listUserOrders({ userId: '7', query: { limit: 20 } });

    expect(repository.userExists).toHaveBeenCalledWith('7');
    expect(page.data).toEqual([]);
    expect(page.pagination.hasMore).toBe(false);
  });

  it('returns 404 for a user who does not exist', async () => {
    const repository = stubRepository([], false);
    const service = createOrdersService(repository);

    const error = await service.listUserOrders({ userId: '7', query: { limit: 20 } }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(404);
    expect((error as AppError).code).toBe('NOT_FOUND');
  });

  it('skips the existence check on an empty page that followed a cursor', async () => {
    const repository = stubRepository([], false);
    const service = createOrdersService(repository);

    const page = await service.listUserOrders({
      userId: '7',
      query: { limit: 20, cursor: { placedAt: ts(1), id: '5' } },
    });

    expect(repository.userExists).not.toHaveBeenCalled();
    expect(page.data).toEqual([]);
  });

  it('converts minor units to a number and leaves ids as strings', async () => {
    const repository = stubRepository([{ ...row('9007199254740993', ts(1)), total_cents: '250' }]);
    const service = createOrdersService(repository);

    const page = await service.listUserOrders({ userId: '7', query: { limit: 20 } });

    expect(page.data[0]).toEqual({
      id: '9007199254740993',
      status: 'paid',
      totalCents: 250,
      currency: 'USD',
      placedAt: ts(1),
    });
  });
});
