import type { ApiError as ApiErrorBody, ErrorCode, PlanLimitDetails } from './types';
import { API_BASE } from '@/env';
import { ERROR_MESSAGES, NETWORK_ERROR_MESSAGE, fieldErrorsFrom, isErrorCode } from '@/lib/errors';
import { xhrUpload } from './xhrUpload';

/** Thrown by apiFetch for every non-2xx response, and for network failures (status 0). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;
  /** The server's own message; `message` is the user-facing text. */
  readonly serverMessage: string | null;
  /** From the Retry-After header on 429, in seconds. */
  retryAfterSeconds: number | null = null;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown, serverMessage?: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.serverMessage = serverMessage ?? null;
  }

  get fieldErrors(): Record<string, string> {
    return this.code === 'validation_failed' ? fieldErrorsFrom(this.details) : {};
  }

  get planLimit(): PlanLimitDetails | null {
    return this.code === 'plan_limit' ? (this.details as PlanLimitDetails) : null;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

interface ClientConfig {
  transport: Transport;
  uploadTransport: UploadTransport;
  getAccessToken: () => Promise<string | null>;
  /** Returns a fresh token, or null if the session cannot be refreshed. */
  refreshAccessToken: () => Promise<string | null>;
  onUnauthorized: () => void;
  onConsentRequired: () => void;
}

// Kept across Vite hot reloads in development: a fresh config would have no token getter, so the next request
// would be sent unsigned, get a 401 and sign you out.
const config: ClientConfig = (import.meta.hot?.data.apiConfig as ClientConfig | undefined) ?? {
  transport: (url, init) => fetch(url, init),
  uploadTransport: (url, request) => xhrUpload(url, request),
  getAccessToken: async () => null,
  refreshAccessToken: async () => null,
  onUnauthorized: () => {},
  onConsentRequired: () => {},
};
if (import.meta.hot) import.meta.hot.data.apiConfig = config;

export function configureApiClient(patch: Partial<ClientConfig>): void {
  Object.assign(config, patch);
}

// For these codes the server message carries specifics the user needs (what is missing, what depends on it).
const USE_SERVER_MESSAGE = new Set<ErrorCode>(['cannot_answer', 'conflict']);

const STATUS_FALLBACK: Record<number, ErrorCode> = {
  401: 'unauthorized',
  402: 'plan_limit',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'file_too_large',
  415: 'file_unsupported',
  422: 'validation_failed',
  429: 'rate_limited',
  502: 'llm_failed',
};

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Accept: 'application/json', Authorization: `Bearer ${token}` } : { Accept: 'application/json' };
}

/** Network failures become a readable ApiError; aborts stay AbortErrors so callers can tell them apart. */
async function guarded(send: () => Promise<Response>): Promise<Response> {
  try {
    return await send();
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'internal', NETWORK_ERROR_MESSAGE);
  }
}

/**
 * The shared request cycle: token, one refresh-and-retry on 401 (expired tokens get 401 too),
 * unwrap { data }, or throw ApiError and fire the global 401 / consent_required handlers.
 */
async function authorised<T>(send: (headers: Record<string, string>) => Promise<Response>): Promise<T> {
  let response = await guarded(async () => send(authHeaders(await config.getAccessToken())));

  if (response.status === 401) {
    const refreshed = await config.refreshAccessToken().catch(() => null);
    if (refreshed) response = await guarded(() => send(authHeaders(refreshed)));
  }

  const payload: unknown = await response.json().catch(() => null);

  if (response.ok) {
    if (payload && typeof payload === 'object' && 'data' in payload) {
      return (payload as { data: T }).data;
    }
    throw new ApiError(response.status, 'internal', ERROR_MESSAGES.internal);
  }

  const error = toApiError(response.status, payload);
  const retryAfter = Number(response.headers.get('Retry-After'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterSeconds = retryAfter;
  if (error.status === 401) config.onUnauthorized();
  else if (error.code === 'consent_required') config.onConsentRequired();
  throw error;
}

/** Calls our API with the Supabase access token, unwraps { data } and throws ApiError otherwise. */
export function apiFetch<T>(path: string, { method = 'GET', body, signal }: ApiRequest = {}): Promise<T> {
  return authorised<T>((headers) =>
    config.transport(`${API_BASE}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    }),
  );
}

export interface UploadRequest {
  form: FormData;
  headers: Record<string, string>;
  onProgress: (fraction: number) => void;
  signal: AbortSignal;
}

/** Sends a multipart POST and reports upload progress. XHR in real mode (fetch has no upload progress). */
export type UploadTransport = (url: string, request: UploadRequest) => Promise<Response>;

/** Multipart POST with progress; same auth, error mapping and global handlers as apiFetch. */
export function apiUpload<T>(
  path: string,
  form: FormData,
  { onProgress, signal }: { onProgress: (fraction: number) => void; signal: AbortSignal },
): Promise<T> {
  return authorised<T>((headers) => config.uploadTransport(`${API_BASE}${path}`, { form, headers, onProgress, signal }));
}

function toApiError(status: number, payload: unknown): ApiError {
  const body = (payload as Partial<ApiErrorBody> | null)?.error;
  const code: ErrorCode = isErrorCode(body?.code) ? body.code : (STATUS_FALLBACK[status] ?? 'internal');
  const serverMessage = typeof body?.message === 'string' && body.message ? body.message : null;
  const message = USE_SERVER_MESSAGE.has(code) && serverMessage ? serverMessage : ERROR_MESSAGES[code];
  return new ApiError(status, code, message, body?.details, serverMessage);
}

/** User-facing text for anything thrown. */
export function errorMessage(error: unknown): string {
  if (isApiError(error)) return error.message;
  return ERROR_MESSAGES.internal;
}
