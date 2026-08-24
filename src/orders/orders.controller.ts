import type { RequestHandler } from 'express';

import type { OrdersService } from './orders.service.js';
import { parseListOrdersQuery, parseUserIdParam } from './orders.schema.js';

// HTTP in, HTTP out. What a page *is* lives in the service, so it stays testable without a request object.
export function createOrdersController(service: OrdersService) {
  const listUserOrders: RequestHandler = async (req, res) => {
    const userId = parseUserIdParam(req.params.id);
    const query = parseListOrdersQuery(req.query);

    const page = await service.listUserOrders({ userId, query });

    // Per-user data behind an Authorization header must never end up in a shared cache.
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(page);
  };

  return { listUserOrders };
}
