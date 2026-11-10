import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiUpload, configureApiClient } from './client';
import { xhrUpload } from './xhrUpload';
import { uploadErrorMessage } from '@/features/datasets/useUpload';

/** A minimal XMLHttpRequest stand-in that the test drives by hand. */
class FakeXhr {
  static last: FakeXhr | null = null;
  status = 0;
  responseText = '';
  method = '';
  url = '';
  headers: Record<string, string> = {};
  responseHeaders: Record<string, string> = {};
  body: unknown = null;
  aborted = false;
  private listeners: Record<string, Array<() => void>> = {};
  private uploadListeners: Record<string, Array<(e: ProgressEvent) => void>> = {};
  upload = {
    addEventListener: (type: string, fn: (e: ProgressEvent) => void) => {
      (this.uploadListeners[type] ??= []).push(fn);
    },
  };

  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getAllResponseHeaders() {
    return Object.entries(this.responseHeaders)
      .map(([k, v]) => `${k.toLowerCase()}: ${v}\r\n`)
      .join('');
  }
  getResponseHeader(name: string) {
    return this.responseHeaders[name] ?? null;
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.listeners.abort?.forEach((fn) => fn());
  }
  // Test helpers
  progress(loaded: number, total: number) {
    this.uploadListeners.progress?.forEach((fn) => fn({ lengthComputable: true, loaded, total } as ProgressEvent));
  }
  respond(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.responseHeaders = headers;
    this.listeners.load?.forEach((fn) => fn());
  }
  failNetwork() {
    this.listeners.error?.forEach((fn) => fn());
  }
}

const original = globalThis.XMLHttpRequest;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('xhrUpload', () => {
  beforeEach(() => {
    FakeXhr.last = null;
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  });
  afterEach(() => {
    globalThis.XMLHttpRequest = original;
  });

  it('posts the form with headers and reports progress as a fraction', async () => {
    const onProgress = vi.fn();
    const form = new FormData();
    const promise = xhrUpload('http://api/x', { form, headers: { Authorization: 'Bearer t' }, onProgress, signal: new AbortController().signal });
    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe('POST');
    expect(xhr.headers.Authorization).toBe('Bearer t');
    expect(xhr.body).toBe(form);

    xhr.progress(25, 100);
    xhr.progress(100, 100);
    expect(onProgress).toHaveBeenNthCalledWith(1, 0.25);
    expect(onProgress).toHaveBeenNthCalledWith(2, 1);

    xhr.respond(201, { data: { id: 'd1' } });
    const response = await promise;
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ data: { id: 'd1' } });
  });

  it('aborts the request when the signal fires', async () => {
    const controller = new AbortController();
    const promise = xhrUpload('http://api/x', { form: new FormData(), headers: {}, onProgress: vi.fn(), signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXhr.last?.aborted).toBe(true);
  });

  it('rejects with a TypeError on a network failure, like fetch', async () => {
    const promise = xhrUpload('http://api/x', { form: new FormData(), headers: {}, onProgress: vi.fn(), signal: new AbortController().signal });
    FakeXhr.last!.failNetwork();
    await expect(promise).rejects.toBeInstanceOf(TypeError);
  });
});

describe('apiUpload error mapping', () => {
  beforeEach(() => {
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    configureApiClient({
      uploadTransport: xhrUpload,
      getAccessToken: async () => 'token',
      refreshAccessToken: async () => null,
      onUnauthorized: () => {},
      onConsentRequired: () => {},
    });
  });
  afterEach(() => {
    globalThis.XMLHttpRequest = original;
  });

  async function uploadAnswering(status: number, body: unknown, headers?: Record<string, string>): Promise<ApiError> {
    const promise = apiUpload('/datasets', new FormData(), { onProgress: () => {}, signal: new AbortController().signal }).catch(
      (e: unknown) => e as ApiError,
    );
    await tick();
    FakeXhr.last!.respond(status, body, headers);
    return (await promise) as ApiError;
  }

  it('maps 402 to plan_limit with its details', async () => {
    const details = { limit_key: 'max_datasets_per_month', limit: 3, used: 3, upgrade_to: 'solo' };
    const error = await uploadAnswering(402, { error: { code: 'plan_limit', message: 'x', details } });
    expect(error).toBeInstanceOf(ApiError);
    expect(error.planLimit).toEqual(details);
  });

  it('maps 413 to file_too_large with a readable message', async () => {
    const error = await uploadAnswering(413, { error: { code: 'file_too_large', message: 'x' } });
    expect(error.code).toBe('file_too_large');
    expect(uploadErrorMessage(error)).toMatch(/larger than the 50 MB/);
  });

  it('maps 415 to file_unsupported and shows the server message as written', async () => {
    const message = 'This is an old Excel .xls file. Save it as .xlsx or CSV and upload it again.';
    const error = await uploadAnswering(415, { error: { code: 'file_unsupported', message } });
    expect(error.code).toBe('file_unsupported');
    expect(uploadErrorMessage(error)).toBe(message);
    const bare = await uploadAnswering(415, { error: { code: 'file_unsupported', message: '' } });
    expect(uploadErrorMessage(bare)).toMatch(/could not read this as a CSV or Excel/);
  });

  it('maps 429 to rate_limited and reads Retry-After', async () => {
    const error = await uploadAnswering(429, { error: { code: 'rate_limited', message: 'x' } }, { 'Retry-After': '30' });
    expect(error.code).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBe(30);
    expect(uploadErrorMessage(error)).toBe('Too many uploads in a short time. Wait 30 seconds and try again.');
  });

  it('unwraps the created dataset on 201', async () => {
    const promise = apiUpload<{ id: string }>('/datasets', new FormData(), { onProgress: () => {}, signal: new AbortController().signal });
    await tick();
    expect(FakeXhr.last!.headers.Authorization).toBe('Bearer token');
    FakeXhr.last!.respond(201, { data: { id: 'd1', status: 'profiling' } });
    await expect(promise).resolves.toEqual({ id: 'd1', status: 'profiling' });
  });
});
