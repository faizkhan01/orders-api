import { pino } from 'pino';

import { env, isProduction, isTest } from './config/env.js';

// JSON to stdout in production; pretty output only for a human terminal, skipped under test.
export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  base: { service: 'orders-api' },
  redact: {
    // Tokens in logs are credentials in logs.
    paths: ['req.headers.authorization', 'req.headers.cookie', 'authorization'],
    censor: '[redacted]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(isProduction || isTest
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }),
});

export type Logger = typeof logger;
