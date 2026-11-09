import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AppError, DbError, STATUS_BY_CODE } from '../../src/lib/errors.js';
import { errorHandler, notFoundHandler } from '../../src/middleware/error.js';
import type { ErrorCode } from '../../src/types/api.js';

function appThrowing(err: unknown) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.post('/boom', () => {
    throw err;
  });
  app.get('/boom', () => {
    throw err;
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('error shape', () => {
  it.each(Object.entries(STATUS_BY_CODE) as Array<[ErrorCode, number]>)('maps %s to HTTP %i', async (code, status) => {
    const res = await request(appThrowing(new AppError(code, 'msg'))).get('/boom');
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: { code, message: 'msg' } });
  });

  it('matches the contract table for the codes Part 1 uses', () => {
    expect(STATUS_BY_CODE).toMatchObject({
      unauthorized: 401,
      consent_required: 403,
      not_found: 404,
      validation_failed: 422,
      plan_limit: 402,
      conflict: 409,
      rate_limited: 429,
      internal: 500,
    });
  });

  it('includes details when given', async () => {
    const details = { limit_key: 'max_workspaces', limit: 1, used: 1, upgrade_to: 'practice' };
    const res = await request(appThrowing(new AppError('plan_limit', 'no', details))).get('/boom');
    expect(res.status).toBe(402);
    expect(res.body.error.details).toEqual(details);
  });

  it('hides internals of unknown errors', async () => {
    const res = await request(appThrowing(new Error('secret connection string'))).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal');
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('hides database errors', async () => {
    const res = await request(appThrowing(new DbError('x', '23505'))).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal');
  });

  it('answers unknown routes with a JSON 404', async () => {
    const res = await request(appThrowing(null)).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
  });

  it('turns malformed JSON into 422 validation_failed', async () => {
    const res = await request(appThrowing(null)).post('/boom').set('content-type', 'application/json').send('{bad');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('turns a body over 100 KB into 422 validation_failed', async () => {
    const big = JSON.stringify({ x: 'a'.repeat(110 * 1024) });
    const res = await request(appThrowing(null)).post('/boom').set('content-type', 'application/json').send(big);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });
});
