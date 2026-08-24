import { env } from '../config/env.js';

const errorContent = { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } };
const statusContent = {
  'application/json': {
    schema: {
      type: 'object',
      properties: { status: { type: 'string' }, database: { type: 'string' } },
    },
  },
};

// Hand-written, not generated from scattered JSDoc comments, so it's reviewable on its own; kept in sync with the route files by hand since it's small enough that drift gets caught in review.
export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'orders-api',
    version: '1.0.0',
    description: "A user's order history, newest first, keyset-paginated. See DECISIONS.md for the reasoning.",
  },
  servers: [{ url: `http://localhost:${env.PORT}`, description: 'local' }],
  security: [{ bearerAuth: [] }],
  paths: {
    '/api/users/{id}/orders': {
      get: {
        summary: "List a user's orders",
        description:
          'Returns the orders belonging to the given user, newest first. The caller must be that ' +
          'user, or an admin. Paginated with an opaque keyset cursor -- pass `pagination.nextCursor` ' +
          'back as `?cursor=` to fetch the next page.',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: "The user's id (a positive integer, as a string).",
            schema: { type: 'string', pattern: '^[1-9][0-9]{0,18}$', example: '2' },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: `Page size, 1–${env.ORDERS_MAX_PAGE_SIZE}. Out of range is a 400, not a clamp.`,
            schema: { type: 'integer', minimum: 1, maximum: env.ORDERS_MAX_PAGE_SIZE, default: env.ORDERS_DEFAULT_PAGE_SIZE },
          },
          {
            name: 'cursor',
            in: 'query',
            required: false,
            description: 'Opaque cursor from a previous response’s `pagination.nextCursor`. Omit for the first page.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'A page of orders. `data` is empty for a real user who has never ordered.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderPage' } } },
          },
          '400': { description: 'Malformed id, limit out of range, unknown query param, or bad cursor.', content: errorContent },
          '401': { description: 'Missing, malformed, unverifiable, or expired bearer token.', content: errorContent },
          '403': { description: 'Authenticated, but not this user and not an admin.', content: errorContent },
          '404': { description: 'No user exists with this id (only returned to a caller entitled to know that).', content: errorContent },
          '503': { description: 'Database unreachable, or the statement timeout fired. `Retry-After` header set.', content: errorContent },
        },
      },
    },
    '/healthz': {
      get: {
        summary: 'Liveness',
        description: 'Does not touch the database, so a database blip cannot fail every instance’s liveness probe at once.',
        security: [],
        responses: { '200': { description: 'The process is alive.', content: statusContent } },
      },
    },
    '/readyz': {
      get: {
        summary: 'Readiness',
        description: 'Pings the database. Returns 503 when it cannot be reached.',
        security: [],
        responses: {
          '200': { description: 'Ready to serve traffic.', content: statusContent },
          '503': { description: 'Database unreachable.', content: statusContent },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Mint one with `npm run token -- --user <id> [--role admin]` (see README.md).',
      },
    },
    schemas: {
      OrderResource: {
        type: 'object',
        required: ['id', 'status', 'totalCents', 'currency', 'placedAt'],
        properties: {
          id: { type: 'string', description: 'orders.id (bigint), as a decimal string.', example: '191' },
          status: {
            type: 'string',
            enum: ['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'],
          },
          totalCents: { type: 'integer', description: 'Integer minor units. Never a float.', example: 270894 },
          currency: { type: 'string', example: 'GBP' },
          placedAt: {
            type: 'string',
            description: 'ISO-8601 UTC, microsecond precision.',
            example: '2026-08-16T04:40:03.547468Z',
          },
        },
      },
      OrderPage: {
        type: 'object',
        required: ['data', 'pagination'],
        properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/OrderResource' } },
          pagination: {
            type: 'object',
            required: ['limit', 'hasMore', 'nextCursor'],
            properties: {
              limit: { type: 'integer' },
              hasMore: { type: 'boolean' },
              nextCursor: { type: 'string', nullable: true, description: 'Null on the last page.' },
            },
          },
        },
      },
      Error: {
        type: 'object',
        required: ['error', 'requestId'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: {
                type: 'string',
                enum: [
                  'VALIDATION_FAILED',
                  'INVALID_CURSOR',
                  'UNAUTHENTICATED',
                  'FORBIDDEN',
                  'NOT_FOUND',
                  'DATABASE_UNAVAILABLE',
                  'INTERNAL_ERROR',
                ],
                description: 'The stable part -- branch on this, not on `message`.',
              },
              message: { type: 'string' },
              issues: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { field: { type: 'string' }, message: { type: 'string' } },
                },
              },
            },
          },
          requestId: { type: 'string', description: 'Echoed in the X-Request-Id response header.' },
        },
      },
    },
  },
} as const;
