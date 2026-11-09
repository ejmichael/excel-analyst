import type { Request, Response } from 'express';
import type { ApiOk } from '../types/api.js';
import { AppError } from './errors.js';

/** Writes the contract's success shape { data }. */
export function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiOk<T> = { data };
  res.status(status).json(body);
}

/** req.auth for routes mounted after requireAuth. */
export function authOf(req: Request): { userId: string; token: string } {
  if (!req.auth) throw new AppError('unauthorized', 'Sign in to continue.');
  return req.auth;
}
