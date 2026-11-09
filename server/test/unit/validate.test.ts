import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler } from '../../src/middleware/error.js';
import { requireUuidParam, validate, validQuery } from '../../src/middleware/validate.js';

function app() {
  const a = express();
  a.use(express.json());
  a.post('/things', validate({ body: z.strictObject({ name: z.string().trim().min(1).max(80) }) }), (req, res) => {
    res.json({ data: req.body });
  });
  a.get('/things', validate({ query: z.strictObject({ limit: z.coerce.number().int().max(200).default(50) }) }), (req, res) => {
    res.json({ data: validQuery(req) });
  });
  a.get('/things/:id', requireUuidParam(), (_req, res) => {
    res.json({ data: 'ok' });
  });
  a.use(errorHandler);
  return a;
}

describe('validate', () => {
  it('passes a valid body through, trimmed', async () => {
    const res = await request(app()).post('/things').send({ name: '  Shop  ' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ name: 'Shop' });
  });

  it('rejects unknown fields with 422', async () => {
    const res = await request(app()).post('/things').send({ name: 'Shop', owner_id: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details.fields).toEqual([expect.objectContaining({ location: 'body' })]);
  });

  it('reports the field path', async () => {
    const res = await request(app()).post('/things').send({ name: '   ' });
    expect(res.status).toBe(422);
    expect(res.body.error.details.fields[0]).toMatchObject({ location: 'body', path: 'name' });
  });

  it('treats a missing body as empty', async () => {
    const res = await request(app()).post('/things');
    expect(res.status).toBe(422);
  });

  it('parses query strings and rejects unknown query keys', async () => {
    expect((await request(app()).get('/things?limit=10')).body.data).toEqual({ limit: 10 });
    expect((await request(app()).get('/things')).body.data).toEqual({ limit: 50 });
    const bad = await request(app()).get('/things?limit=10&extra=1');
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.fields[0].location).toBe('query');
  });

  it('answers 404 for a malformed id', async () => {
    expect((await request(app()).get('/things/not-a-uuid')).status).toBe(404);
    expect((await request(app()).get('/things/3f1c2a8e-5b7d-4c1e-9a2b-6d8e0f1a2b3c')).status).toBe(200);
  });
});
