import type { RequestHandler } from 'express';

import { forbidden, unauthenticated } from '../http/errors.js';
import { parseUserIdParam } from '../orders/orders.schema.js';

// Requirement 4: only the user themself, or an admin, may view a user's orders. Runs before any database read, so an unentitled caller can't even learn whether the user exists.
export const requireSelfOrAdmin: RequestHandler = (req, _res, next) => {
  const auth = req.auth;
  if (!auth) {
    // Only reachable if `authenticate` is missing from the chain -- a wiring bug, fail closed.
    throw unauthenticated();
  }

  // Re-parsed rather than trusted from an earlier middleware, so "13" vs "013" can't become a bypass.
  const targetUserId = parseUserIdParam(req.params.id);

  if (auth.role !== 'admin' && auth.userId !== targetUserId) {
    throw forbidden('You may only view your own orders.');
  }

  next();
};
