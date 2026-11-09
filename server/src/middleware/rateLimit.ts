import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit, type RateLimitInfo } from 'express-rate-limit';
import { AppError } from '../lib/errors.js';

const WINDOW_MS = 60_000;

const ipKey = (req: Request) => `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;

/** 429 rate_limited in the contract's error shape, with Retry-After in seconds. */
const handler = (req: Request, res: Response, next: NextFunction) => {
  const reset = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit?.resetTime;
  const seconds = reset ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000)) : WINDOW_MS / 1000;
  res.setHeader('Retry-After', String(seconds));
  next(new AppError('rate_limited', 'Too many requests. Please wait a moment and try again.'));
};

/**
 * Before auth: 300 per minute per IP, counting only requests that did not authenticate
 * (health checks, bad tokens, unknown routes). Authenticated requests are uncounted here
 * so several users behind one office IP do not share a bucket.
 */
export const ipRateLimit: RequestHandler = rateLimit({
  windowMs: WINDOW_MS,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: ipKey,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req) => req.auth !== undefined,
  handler,
});

/** After auth: 300 per minute per user. */
export const userRateLimit: RequestHandler = rateLimit({
  windowMs: WINDOW_MS,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => (req.auth ? `user:${req.auth.userId}` : ipKey(req)),
  handler,
});
