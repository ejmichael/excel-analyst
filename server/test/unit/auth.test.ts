import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { classifyAuthError, createRequireAuth, createSupabaseVerifier } from '../../src/middleware/auth.js';
import { errorHandler } from '../../src/middleware/error.js';

const USER = '11111111-1111-4111-8111-111111111111';
const ok = { data: { user: { id: USER } }, error: null };
const fail = (status: number | undefined, name = 'AuthApiError') => ({ data: { user: null }, error: { status, name } });
const noSleep = async () => undefined;

function app(getUser: Parameters<typeof createSupabaseVerifier>[0]) {
  const a = express();
  a.use(createRequireAuth(createSupabaseVerifier(getUser, noSleep)));
  a.get('/x', (_req, res) => {
    res.json({ data: 'ok' });
  });
  a.use(errorHandler);
  return a;
}

describe('classifyAuthError', () => {
  it('treats 400/401/403/404 as a bad token and everything else as Auth being unavailable', () => {
    for (const s of [400, 401, 403, 404]) expect(classifyAuthError({ status: s })).toBe('invalid');
    expect(classifyAuthError({ status: 429 })).toBe('rate_limited');
    for (const s of [0, 500, 502, 503, undefined]) expect(classifyAuthError({ status: s })).toBe('unavailable');
  });
});

describe('token verification against Supabase Auth', () => {
  it('accepts a valid token', async () => {
    expect((await request(app(async () => ok)).get('/x').set('Authorization', 'Bearer t')).status).toBe(200);
  });

  it('answers 401 when Supabase rejects the token, without retrying', async () => {
    const getUser = vi.fn(async () => fail(403));
    const res = await request(app(getUser)).get('/x').set('Authorization', 'Bearer t');
    expect(res.status).toBe(401);
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it('retries once when Auth is unreachable and succeeds', async () => {
    const getUser = vi.fn().mockResolvedValueOnce(fail(0, 'AuthRetryableFetchError')).mockResolvedValueOnce(ok);
    expect((await request(app(getUser)).get('/x').set('Authorization', 'Bearer t')).status).toBe(200);
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it('answers 500, never 401, when Auth stays unreachable (so the client does not sign the user out)', async () => {
    const res = await request(app(async () => fail(503))).get('/x').set('Authorization', 'Bearer t');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'internal', message: expect.stringMatching(/could not check your sign-in/) });
  });

  it('answers 429 when Auth keeps rate-limiting the check', async () => {
    const res = await request(app(async () => fail(429))).get('/x').set('Authorization', 'Bearer t');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect(res.headers['retry-after']).toBe('5');
  });
});
