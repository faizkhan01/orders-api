import { z } from 'zod';

// Parsed once at import time; the process exits rather than serving with bad config.
if (process.env.NODE_ENV !== 'test') {
  // Skipped under test: the test runner supplies its own env, and a dev .env must not leak in.
  try {
    process.loadEnvFile();
  } catch {
    // No .env file. Expected in CI and in any real deployment.
  }
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    // A database-side budget: every instance multiplies this against max_connections.
    PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    /** Fail fast when the pool is saturated instead of queueing forever. */
    PG_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
    // Enforced by Postgres itself, so a client giving up does not leave the query running.
    PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),

    /** HS256 shared secret. See DECISIONS.md on why symmetric is a stand-in. */
    JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
    JWT_ISSUER: z.string().default('orders-api'),
    JWT_AUDIENCE: z.string().default('orders-api'),

    ORDERS_DEFAULT_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(20),
    // The only real defence against `?limit=1000000`.
    ORDERS_MAX_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(100),
  })
  .superRefine((value, ctx) => {
    if (value.ORDERS_DEFAULT_PAGE_SIZE > value.ORDERS_MAX_PAGE_SIZE) {
      ctx.addIssue({
        code: 'custom',
        path: ['ORDERS_DEFAULT_PAGE_SIZE'],
        message: 'ORDERS_DEFAULT_PAGE_SIZE must not exceed ORDERS_MAX_PAGE_SIZE',
      });
    }
    // Enforced only in production so the sample secret in .env.example stays usable.
    if (value.NODE_ENV === 'production' && value.JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET must be at least 32 characters in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Deliberately not the logger: the logger's level comes from this config.
    console.error(`Invalid environment configuration:\n${details}`);
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
