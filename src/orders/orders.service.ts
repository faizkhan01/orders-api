import { notFound } from '../http/errors.js';
import { encodeCursor } from './cursor.js';
import type { OrderRow, OrdersRepository } from './orders.repository.js';
import type { ListOrdersQuery } from './orders.schema.js';

// The response resource, deliberately not the row shape -- column names shouldn't be an API contract.
export interface OrderResource {
  readonly id: string;
  readonly status: string;
  /** Minor units, as a number -- exact to 2^53 cents, well past where this service is the problem. */
  readonly totalCents: number;
  readonly currency: string;
  /** ISO-8601 UTC, microsecond precision. */
  readonly placedAt: string;
}

export interface OrderPage {
  readonly data: readonly OrderResource[];
  readonly pagination: {
    readonly limit: number;
    readonly hasMore: boolean;
    /** Opaque; pass back as `?cursor=`. Null on the last page. */
    readonly nextCursor: string | null;
  };
}

export interface OrdersService {
  listUserOrders(params: { userId: string; query: ListOrdersQuery }): Promise<OrderPage>;
}

export function createOrdersService(repository: OrdersRepository): OrdersService {
  return {
    async listUserOrders({ userId, query }) {
      const { limit, cursor } = query;

      // Fetch one row more than the page size: that spare row is how hasMore is known without a COUNT(*) on every page.
      const rows = await repository.findOrdersByUserId({ userId, limit: limit + 1, cursor });

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      // "No orders" (200+[]) vs "no such user" (404) differ; the existence check only runs on an empty page with no cursor, since a cursor means the caller already knows the user exists.
      if (pageRows.length === 0 && cursor === undefined) {
        const exists = await repository.userExists(userId);
        if (!exists) {
          throw notFound(`No user exists with id ${userId}.`);
        }
      }

      const lastRow = pageRows.at(-1);

      return {
        data: pageRows.map(toResource),
        pagination: {
          limit,
          hasMore,
          // Only emitted when there's something after it, so the last page doesn't invite one more request.
          nextCursor: hasMore && lastRow ? encodeCursor({ placedAt: lastRow.placed_at, id: lastRow.id }) : null,
        },
      };
    },
  };
}

function toResource(row: OrderRow): OrderResource {
  return {
    id: row.id,
    status: row.status,
    totalCents: Number(row.total_cents),
    currency: row.currency,
    placedAt: row.placed_at,
  };
}
