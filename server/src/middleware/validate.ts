import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';

type Location = 'body' | 'query' | 'params';

export interface FieldError {
  location: Location;
  path: string;
  message: string;
}

interface Schemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

/**
 * Parses body, query and params with zod. Use z.strictObject so unknown fields are rejected.
 * Failures become 422 validation_failed with details: { fields: FieldError[] }.
 * The parsed body replaces req.body; parsed query and params go to req.valid (read them with validQuery/validParams).
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const fields: FieldError[] = [];
    const parsed: Partial<Record<Location, unknown>> = {};
    for (const location of ['params', 'query', 'body'] as const) {
      const schema = schemas[location];
      if (!schema) continue;
      const input: unknown = location === 'body' ? (req.body ?? {}) : req[location];
      const result = schema.safeParse(input);
      if (result.success) {
        parsed[location] = result.data;
      } else {
        for (const issue of result.error.issues) {
          fields.push({ location, path: issue.path.join('.'), message: issue.message });
        }
      }
    }
    if (fields.length > 0) {
      throw new AppError('validation_failed', 'Some fields are not valid.', { fields });
    }
    if ('body' in parsed) req.body = parsed.body;
    req.valid = { query: parsed.query, params: parsed.params };
    next();
  };
}

export const validQuery = <T>(req: Request): T => req.valid?.query as T;
export const validParams = <T>(req: Request): T => req.valid?.params as T;

/**
 * Route ids are UUIDs. A malformed id cannot match any row, so it answers 404 like a missing one
 * instead of 422 (this also keeps it from reaching Postgres as an invalid uuid).
 */
export function requireUuidParam(name = 'id'): RequestHandler {
  const uuid = z.uuid();
  return (req, _res, next) => {
    if (!uuid.safeParse(req.params[name]).success) throw new AppError('not_found', 'Not found.');
    next();
  };
}
