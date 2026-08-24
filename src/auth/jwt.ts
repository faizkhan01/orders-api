import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { env } from '../config/env.js';
import { unauthenticated } from '../http/errors.js';

export const ROLES = ['customer', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface AuthContext {
  /** The authenticated user's id, as a string -- users.id is a bigint. */
  readonly userId: string;
  readonly role: Role;
}

// A signature proves origin, not shape, so claims are schema-validated after verification.
const claimsSchema = z.object({
  sub: z.string().regex(/^[1-9]\d{0,18}$/, 'sub must be a positive integer id'),
  role: z.enum(ROLES),
});

const VERIFY_OPTIONS: jwt.VerifyOptions = {
  // Pinned explicitly to avoid the classic HS256/RS256 (or `alg: "none"`) confusion.
  algorithms: ['HS256'],
  issuer: env.JWT_ISSUER,
  audience: env.JWT_AUDIENCE,
  clockTolerance: 5, // seconds, for ordinary clock skew between hosts
};

// Throws a 401 for every failure mode with one generic message -- which check failed is a free oracle.
export function verifyAccessToken(token: string): AuthContext {
  let payload: unknown;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, VERIFY_OPTIONS);
  } catch (error) {
    // "expired" gets its own message because a client can act on it (refresh); exp isn't a secret.
    if (error instanceof jwt.TokenExpiredError) {
      throw unauthenticated('The access token has expired.');
    }
    throw unauthenticated('The access token is invalid.');
  }

  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) {
    throw unauthenticated('The access token is invalid.');
  }

  return { userId: claims.data.sub, role: claims.data.role };
}

// Only for `npm run token` and tests -- a real deployment issues tokens from an identity provider.
export function signAccessToken(params: { userId: string; role: Role; expiresIn?: string | number }): string {
  return jwt.sign({ role: params.role }, env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: params.userId,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: params.expiresIn ?? '1h',
  } as jwt.SignOptions);
}
