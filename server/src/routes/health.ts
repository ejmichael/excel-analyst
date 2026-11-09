import { Router } from 'express';
import { ok } from '../lib/http.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  ok(res, { status: 'ok' as const, time: new Date().toISOString() });
});
