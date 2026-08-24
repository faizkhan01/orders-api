// The environment the test suite runs under, always a separate <name>_test database since fixtures TRUNCATE; no src/ import, since src/config/env.ts can process.exit(1) on bad config.

const DEFAULT_DATABASE_URL = 'postgres://orders:orders@localhost:5433/orders_api';

function withDatabaseName(connectionString: string, name: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
}

export function resolveTestDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const currentName = new URL(base).pathname.replace(/^\//, '') || 'orders_api';
  return withDatabaseName(base, currentName.endsWith('_test') ? currentName : `${currentName}_test`);
}

export function testEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: resolveTestDatabaseUrl(),
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256',
    JWT_ISSUER: 'orders-api',
    JWT_AUDIENCE: 'orders-api',
    ORDERS_DEFAULT_PAGE_SIZE: '20',
    ORDERS_MAX_PAGE_SIZE: '100',
    // Small pool: a leaked client shows up as a hang in one test, not flakiness later.
    PG_POOL_MAX: '4',
  };
}
