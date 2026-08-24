import express, { type Express, Router } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';

import './http/types.js';

import { isProduction } from './config/env.js';
import { openApiDocument } from './docs/openapi.js';
import { pingDatabase } from './db/pool.js';
import { errorHandler, notFoundHandler } from './http/error-handler.js';
import { requestContext } from './http/request-context.js';
import { createOrdersRepository } from './orders/orders.repository.js';
import { createOrdersRouter } from './orders/orders.routes.js';
import { createOrdersService, type OrdersService } from './orders/orders.service.js';

export interface AppDependencies {
  /** Injectable so the service can be unit-tested without HTTP, and vice versa. */
  ordersService?: OrdersService;
  checkDatabase?: () => Promise<void>;
}

export function createApp(deps: AppDependencies = {}): Express {
  const ordersService = deps.ordersService ?? createOrdersService(createOrdersRepository());
  const checkDatabase = deps.checkDatabase ?? pingDatabase;

  const app = express();

  app.disable('x-powered-by');
  // No ETag: Postgres does the sorting, responses are no-store anyway.
  app.disable('etag');
  // Simple query parser: `?a[b]=c` isn't part of this API's contract, so validation sees fewer shapes.
  app.set('query parser', 'simple');
  // Off by default: with trust proxy enabled, req.ip comes from a caller-controlled header.
  app.set('trust proxy', false);

  app.use(requestContext());
  app.use(
    helmet({
      // JSON API, no documents served -- the browser-facing CSP is inert here.
      contentSecurityPolicy: false,
    }),
  );

  // No body parser: this API accepts no request bodies.

  app.use(healthRouter(checkDatabase));
  // Off in production: an API explorer isn't something to expose alongside real customer data.
  if (!isProduction) {
    app.get('/openapi.json', (_req, res) => res.json(openApiDocument));
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));
  }
  app.use('/api', createOrdersRouter(ordersService));

  app.use(notFoundHandler);
  app.use(errorHandler());

  return app;
}

// /healthz never touches the database -- otherwise a database blip fails every instance's liveness probe at once. /readyz does check.
function healthRouter(checkDatabase: () => Promise<void>): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/readyz', async (req, res) => {
    try {
      await checkDatabase();
      res.json({ status: 'ok', database: 'ok' });
    } catch (error) {
      req.log.error({ err: error }, 'readiness check failed');
      res.status(503).json({ status: 'degraded', database: 'unavailable' });
    }
  });

  return router;
}
