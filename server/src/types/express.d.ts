import 'express';

declare global {
  namespace Express {
    interface Request {
      /** Set by middleware/auth.ts. */
      auth?: { userId: string; token: string };
      /** Parsed query and params, set by middleware/validate.ts (Express 5 makes req.query read-only). */
      valid?: { query?: unknown; params?: unknown };
    }
  }
}
