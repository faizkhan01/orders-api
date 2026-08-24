import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool, pingDatabase } from './db/pool.js';
import { logger } from './logger.js';

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  // Prove the database is reachable before listening, so a rollout can't replace healthy instances with ones that fail immediately.
  await pingDatabase();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'orders-api listening');
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    // unref() so this timer itself isn't a reason to stay alive.
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();

    // Close idle sockets immediately, let in-flight requests finish -- drains fast, drops nothing.
    server.closeIdleConnections();
    server.close((error) => {
      if (error) logger.error({ err: error }, 'error closing http server');
      closePool()
        .catch((poolError: unknown) => logger.error({ err: poolError }, 'error closing pg pool'))
        .finally(() => {
          clearTimeout(force);
          process.exit(error ? 1 : 0);
        });
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Crash-only: an event loop in an unknown state shouldn't keep serving traffic.
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    shutdown('unhandledRejection');
  });
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
});
