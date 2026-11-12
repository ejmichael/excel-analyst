import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';

describe('CORS', () => {
  // Unit tests run without server/.env: dummy values (no real keys), set before the config is first read.
  beforeAll(() => {
    const dummy: Record<string, string> = {
      APP_NAME: 'Analyst',
      CLIENT_URL: 'http://localhost:5173',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_ANON_KEY: 'test-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service',
      LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'test-key',
      ANTHROPIC_MODEL_PLANNER: 'test-planner',
      ANTHROPIC_MODEL_FAST: 'test-fast',
    };
    for (const [k, v] of Object.entries(dummy)) if (!process.env[k]) vi.stubEnv(k, v);
  });

  it('lets the client read Retry-After and Content-Disposition on a cross-origin response', async () => {
    const res = await request(createApp()).get('/api/v1/health').set('Origin', env().CLIENT_URL);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(env().CLIENT_URL);
    const exposed = String(res.headers['access-control-expose-headers'] ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase());
    expect(exposed).toEqual(expect.arrayContaining(['retry-after', 'content-disposition']));
  });

  it('only ever allows the client origin', async () => {
    // cors() with a single origin always sends that origin; the browser then blocks any other page from reading the response.
    const res = await request(createApp()).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBe(env().CLIENT_URL);
  });
});
