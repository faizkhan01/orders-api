import type { AuthContext } from '../auth/jwt.js';
import type { Logger } from '../logger.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlation id for this request, echoed in the response and every log line. */
      id: string;
      /** Request-scoped logger, pre-tagged with the correlation id. */
      log: Logger;
      /** Optional so a route that skips `authenticate` fails to compile, not at runtime. */
      auth?: AuthContext;
    }
  }
}

export {};
