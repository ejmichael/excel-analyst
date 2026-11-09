import type { ApiError as ApiErrorBody, ErrorCode, PlanLimitDetails } from './types';
import { API_BASE } from '@/env';
import { ERROR_MESSAGES, NETWORK_ERROR_MESSAGE, fieldErrorsFrom, isErrorCode } from '@/lib/errors';

/** Thrown by apiFetch for every non-2xx response, and for network failures (status 0). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;
  /** The server's own message; `message` is the user-facing text. */
  readonly serverMessage: string | null;

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
  getAccessToken: () => Promise<string | null>;
  /** Returns a fresh token, or null if the session cannot be refreshed. */
  refreshAccessToken: () => Promise<string | null>;
  onUnauthorized: () => void;
  onConsentRequired: () => void;
}

const config: ClientConfig = {
  transport: (url, init) => fetch(url, init),
  getAccessToken: async () => null,
  refreshAccessToken: async () => null,
  onUnauthorized: () => {},
  onConsentRequired: () => {},
};

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

async function send(path: string, { method = 'GET', body, signal }: ApiRequest, token: string | null) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await config.transport(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'internal', NETWORK_ERROR_MESSAGE);
  }
}

/** Calls our API with the Supabase access token, unwraps { data } and throws ApiError otherwise. */
export async function apiFetch<T>(path: string, request: ApiRequest = {}): Promise<T> {
  let response = await send(path, request, await config.getAccessToken());

  // An expired token also gets 401: refresh the session and retry once before giving up.
  if (response.status === 401) {
    const refreshed = await config.refreshAccessToken().catch(() => null);
    if (refreshed) response = await send(path, request, refreshed);
  }

  const payload: unknown = await response.json().catch(() => null);

  if (response.ok) {
    if (payload && typeof payload === 'object' && 'data' in payload) {
      return (payload as { data: T }).data;
    }
    throw new ApiError(response.status, 'internal', ERROR_MESSAGES.internal);
  }

  const error = toApiError(response.status, payload);
  if (error.status === 401) config.onUnauthorized();
  else if (error.code === 'consent_required') config.onConsentRequired();
  throw error;
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
