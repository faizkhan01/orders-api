import type { ErrorRequestHandler, RequestHandler } from 'express';

import { AppError, type ErrorCode, type FieldIssue, notFound } from './errors.js';

interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    issues?: readonly FieldIssue[];
  };
  requestId: string;
}

/** Postgres SQLSTATEs worth translating into something a client can act on. */
const PG_QUERY_CANCELED = '57014'; // statement_timeout fired
const PG_ADMIN_SHUTDOWN = '57P01'; // server restarting / failover
const PG_TOO_MANY_CONNECTIONS = '53300';

function isPgError(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

// Anything the router did not match, so unmatched routes get the same error envelope as everything else.
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(notFound('The requested endpoint does not exist.'));
};

// The single place that decides what the client is told: AppError messages pass through verbatim, everything else becomes a generic message + request id.
export function errorHandler(): ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) {
      // Status line already sent; nothing left to say but pass it on.
      req.log?.error({ err: error }, 'error after response started');
      next(error);
      return;
    }

    const mapped = mapError(error);

    if (mapped.status >= 500) {
      req.log.error({ err: error, status: mapped.status, code: mapped.code }, 'request failed');
    } else {
      // Expected outcomes (401s, 403s, bad cursors) are signal, not incidents.
      req.log.warn({ code: mapped.code, status: mapped.status }, 'request rejected');
    }

    if (mapped.status === 503) {
      res.setHeader('Retry-After', '1');
    }

    const body: ErrorBody = {
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.issues ? { issues: mapped.issues } : {}),
      },
      requestId: req.id,
    };

    res.status(mapped.status).json(body);
  };
}

function mapError(error: unknown): {
  status: number;
  code: ErrorCode;
  message: string;
  issues?: readonly FieldIssue[];
} {
  if (error instanceof AppError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error.issues ? { issues: error.issues } : {}),
    };
  }

  if (isPgError(error)) {
    if (
      error.code === PG_QUERY_CANCELED ||
      error.code === PG_ADMIN_SHUTDOWN ||
      error.code === PG_TOO_MANY_CONNECTIONS ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT'
    ) {
      // Retryable, so it's a 503 a client can back off from, not a 500 in the bug queue.
      return {
        status: 503,
        code: 'DATABASE_UNAVAILABLE',
        message: 'The service is temporarily unable to read order data. Please retry.',
      };
    }
  }

  // node-postgres surfaces pool acquisition timeouts as a plain Error.
  if (error instanceof Error && /timeout exceeded when trying to connect/i.test(error.message)) {
    return {
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      message: 'The service is temporarily unable to read order data. Please retry.',
    };
  }

  return { status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' };
}
