import type { RequestHandler } from 'express';

import { unauthenticated } from '../http/errors.js';
import { verifyAccessToken } from './jwt.js';

// `Authorization: Bearer <jwt>` -> req.auth. Scheme match is case-insensitive per RFC 7235.
export function authenticate(): RequestHandler {
  return (req, _res, next) => {
    const header = req.get('authorization');
    if (!header) {
      throw unauthenticated('An Authorization header is required.');
    }

    const [scheme, ...rest] = header.split(' ');
    const token = rest.join(' ').trim();
    if (scheme?.toLowerCase() !== 'bearer' || token.length === 0) {
      throw unauthenticated('Expected an Authorization header of the form "Bearer <token>".');
    }

    req.auth = verifyAccessToken(token);
    next();
  };
}
