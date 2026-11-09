import type { IncomingMessage, ServerResponse } from 'node:http';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';

const isTest = process.env.NODE_ENV === 'test';

/** Log ids, status codes, sizes and timings only. Never tokens, keys, bodies, emails or file contents. */
export const logger = pino({
  level: isTest ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-cron-secret"]', '*.token', '*.email'],
    censor: '[redacted]',
  },
});

export const httpLogger = pinoHttp({
  logger,
  // Keep request logs to method and path; query strings and headers can carry tokens.
  serializers: {
    req: (req: IncomingMessage & { id?: unknown }) => ({
      id: req.id,
      method: req.method,
      path: (req.url ?? '').split('?')[0],
    }),
    res: (res: ServerResponse) => ({ status: res.statusCode }),
  },
  customProps: (req) => ({ user_id: (req as { auth?: { userId: string } }).auth?.userId }),
  customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
});
