import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, DbError } from '../lib/errors.js';
import { StorageError } from '../lib/storage.js';
import type { ApiError } from '../types/api.js';

/** JSON 404 for unknown routes. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError('not_found', 'This route does not exist.'));
};

/** Errors raised by express.json() carry a `type` and a status. */
function bodyParserError(err: unknown): AppError | null {
  if (typeof err !== 'object' || err === null || !('type' in err)) return null;
  switch ((err as { type: unknown }).type) {
    case 'entity.too.large':
      return new AppError('validation_failed', 'The request body is larger than 100 KB.');
    case 'entity.parse.failed':
      return new AppError('validation_failed', 'The request body is not valid JSON.');
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return new AppError('validation_failed', 'The request body encoding is not supported.');
    default:
      return null;
  }
}

/** The only place error responses are written. Always the contract's ApiError shape; never leaks internals. */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const appError = err instanceof AppError ? err : bodyParserError(err);
  if (appError) {
    const body: ApiError = { error: { code: appError.code, message: appError.message } };
    if (appError.details !== undefined) body.error.details = appError.details;
    res.status(appError.status).json(body);
    return;
  }
  // Log the error kind, never request bodies or database values.
  const log = req.log;
  if (err instanceof DbError) {
    log?.error({ op: err.op, db_code: err.dbCode }, 'database error');
  } else if (err instanceof StorageError) {
    log?.error({ op: err.op }, 'storage error');
  } else {
    log?.error({ err_name: err instanceof Error ? err.name : typeof err, stack: err instanceof Error ? err.stack : undefined }, 'unhandled error');
  }
  const body: ApiError = { error: { code: 'internal', message: 'Something went wrong on our side. Please try again.' } };
  res.status(500).json(body);
};
