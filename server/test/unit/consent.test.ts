import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createRequireAuth } from '../../src/middleware/auth.js';
import { createRequireConsent } from '../../src/middleware/consent.js';
import { errorHandler } from '../../src/middleware/error.js';

const USER = '11111111-1111-4111-8111-111111111111';

function app(accepted: boolean) {
  const lookup = vi.fn(async () => accepted);
  const a = express();
  a.use(createRequireAuth(async (token) => (token === 'good' ? USER : null)));
  a.get('/me', (_req, res) => {
    res.json({ data: 'me' });
  });
  a.use(createRequireConsent(lookup));
  a.get('/workspaces', (_req, res) => {
    res.json({ data: [] });
  });
  a.use(errorHandler);
  return { a, lookup };
}

describe('auth and consent middleware', () => {
  it('401 without a token', async () => {
    const res = await request(app(true).a).get('/workspaces');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('401 with an invalid token', async () => {
    const res = await request(app(true).a).get('/workspaces').set('Authorization', 'Bearer bad');
    expect(res.status).toBe(401);
  });

  it('401 for a non-Bearer scheme', async () => {
    const res = await request(app(true).a).get('/workspaces').set('Authorization', 'Basic good');
    expect(res.status).toBe(401);
  });

  it('403 consent_required before consent', async () => {
    const { a, lookup } = app(false);
    const res = await request(a).get('/workspaces').set('Authorization', 'Bearer good');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('consent_required');
    expect(lookup).toHaveBeenCalledWith(USER, 'good');
  });

  it('allows routes mounted before the consent middleware', async () => {
    const res = await request(app(false).a).get('/me').set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
  });

  it('passes after consent', async () => {
    const res = await request(app(true).a).get('/workspaces').set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
  });
});
