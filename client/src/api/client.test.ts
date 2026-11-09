import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ApiError, apiFetch, configureApiClient, type Transport } from './client';
import { API_BASE } from '@/env';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('apiFetch', () => {
  const onUnauthorized = vi.fn();
  const onConsentRequired = vi.fn();
  let transport: Mock<Transport>;

  beforeEach(() => {
    transport = vi.fn<Transport>();
    configureApiClient({
      transport,
      getAccessToken: async () => 'token-123',
      refreshAccessToken: async () => null,
      onUnauthorized,
      onConsentRequired,
    });
  });

  afterEach(() => vi.clearAllMocks());

  it('sends the bearer token to the versioned base path and unwraps { data }', async () => {
    transport.mockResolvedValue(json(200, { data: { hello: 'world' } }));
    await expect(apiFetch<{ hello: string }>('/me')).resolves.toEqual({ hello: 'world' });

    const [url, init] = transport.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/me`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
  });

  it('sends JSON bodies', async () => {
    transport.mockResolvedValue(json(201, { data: { id: 'w1' } }));
    await apiFetch('/workspaces', { method: 'POST', body: { name: 'Shop' } });
    const [, init] = transport.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'Shop' }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('throws a typed ApiError with code and details', async () => {
    const details = { limit_key: 'max_workspaces', limit: 1, used: 1, upgrade_to: 'practice' };
    transport.mockResolvedValue(json(402, { error: { code: 'plan_limit', message: 'Limit', details } }));

    const error = await apiFetch('/workspaces', { method: 'POST', body: { name: 'x' } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(402);
    expect(apiError.code).toBe('plan_limit');
    expect(apiError.details).toEqual(details);
    expect(apiError.planLimit).toEqual(details);
    expect(apiError.message).toMatch(/limit of your plan/);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(onConsentRequired).not.toHaveBeenCalled();
  });

  it('exposes validation_failed field errors', async () => {
    transport.mockResolvedValue(
      json(422, {
        error: {
          code: 'validation_failed',
          message: 'Some fields are not valid.',
          details: { fields: [{ location: 'body', path: 'name', message: 'Too long' }] },
        },
      }),
    );
    const error = (await apiFetch('/workspaces').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('validation_failed');
    expect(error.fieldErrors).toEqual({ name: 'Too long' });
  });

  it('maps consent_required to the consent handler', async () => {
    transport.mockResolvedValue(json(403, { error: { code: 'consent_required', message: 'Accept first' } }));
    const error = (await apiFetch('/workspaces').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('consent_required');
    expect(onConsentRequired).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('maps any 401 to the sign-out handler', async () => {
    transport.mockResolvedValue(json(401, { error: { code: 'unauthorized', message: 'Bad token' } }));
    const error = (await apiFetch('/me').catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(401);
    expect(error.code).toBe('unauthorized');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onConsentRequired).not.toHaveBeenCalled();
  });

  it('refreshes the token and retries once after a 401 before signing out', async () => {
    configureApiClient({ refreshAccessToken: async () => 'token-fresh' });
    transport
      .mockResolvedValueOnce(json(401, { error: { code: 'unauthorized', message: 'Expired' } }))
      .mockResolvedValueOnce(json(200, { data: { ok: true } }));

    await expect(apiFetch('/me')).resolves.toEqual({ ok: true });
    expect(transport).toHaveBeenCalledTimes(2);
    const [, retry] = transport.mock.calls[1] as [string, RequestInit];
    expect((retry.headers as Record<string, string>).Authorization).toBe('Bearer token-fresh');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('signs out when the retry after a refresh is still 401', async () => {
    configureApiClient({ refreshAccessToken: async () => 'token-fresh' });
    transport.mockResolvedValue(json(401, { error: { code: 'unauthorized', message: 'Revoked' } }));

    const error = (await apiFetch('/me').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('unauthorized');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('treats a 401 without a JSON body as unauthorized too', async () => {
    transport.mockResolvedValue(new Response('nope', { status: 401 }));
    const error = (await apiFetch('/me').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('unauthorized');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('turns a network failure into a readable ApiError', async () => {
    transport.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = (await apiFetch('/me').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.message).toMatch(/could not reach the server/);
  });
});
