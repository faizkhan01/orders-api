import { Router } from 'express';

import { authenticate } from '../auth/authenticate.js';
import { requireSelfOrAdmin } from '../auth/authorize.js';
import { createOrdersController } from './orders.controller.js';
import type { OrdersService } from './orders.service.js';

// GET /api/users/:id/orders -- middleware order is the security model: authenticate (401) -> requireSelfOrAdmin (403) -> controller (400/404), strictly before any database read.
export function createOrdersRouter(service: OrdersService): Router {
  const router = Router();
  const controller = createOrdersController(service);

  router.get('/users/:id/orders', authenticate(), requireSelfOrAdmin, controller.listUserOrders);

  return router;
}
