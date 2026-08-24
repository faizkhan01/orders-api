import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { logger } from '../logger.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

// Attaches a correlation id and a request-scoped logger, then logs one line per completed request.
export function requestContext(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const inbound = req.get('x-request-id');
    // Validated before use: it lands in log output, and unbounded caller-controlled strings there are how log injection happens.
    req.id = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
    req.log = logger.child({ requestId: req.id });
    res.setHeader('X-Request-Id', req.id);

    const startedAt = process.hrtime.bigint();

    res.once('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      req.log[level](
        {
          method: req.method,
          // Route pattern, not req.originalUrl, so 500,000 user ids don't become 500,000 labels.
          route: (req.route as { path?: string } | undefined)?.path ?? req.path,
          status: res.statusCode,
          durationMs: Number(durationMs.toFixed(2)),
        },
        'request completed',
      );
    });

    next();
  };
}
