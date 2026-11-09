import type { ErrorCode, PlanLimitDetails } from '../types/api.js';

/** HTTP status for every ErrorCode, as listed in docs/API_CONTRACT.md. */
export const STATUS_BY_CODE: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  consent_required: 403,
  not_found: 404,
  validation_failed: 422,
  cannot_answer: 422,
  schema_mismatch: 422,
  file_unsupported: 415,
  file_too_large: 413,
  plan_limit: 402,
  dataset_not_ready: 409,
  dataset_expired: 410,
  conflict: 409,
  rate_limited: 429,
  llm_failed: 502,
  internal: 500,
};

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    status?: number,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status ?? STATUS_BY_CODE[code];
  }
}

export const notFound = (what = 'Not found') => new AppError('not_found', what);

export const planLimit = (details: PlanLimitDetails) =>
  new AppError('plan_limit', 'Your plan does not allow this. Upgrade to continue.', details);

/** Wraps a Supabase/PostgREST error so the handler logs its code only and answers 500. */
export class DbError extends Error {
  constructor(
    readonly op: string,
    readonly dbCode: string | undefined,
  ) {
    super(`Database error during ${op}`);
    this.name = 'DbError';
  }
}

export function throwIfDbError(op: string, error: { code?: string } | null): void {
  if (error) throw new DbError(op, error.code);
}
