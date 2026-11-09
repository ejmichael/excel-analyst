import type { ErrorCode, Plan } from '@/api/types';

/** The one place every contract error code is turned into words a user can act on. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  unauthorized: 'Your session has ended. Please sign in again.',
  forbidden: 'You do not have access to this.',
  consent_required: 'Please accept the Terms of use and the Privacy notice to continue.',
  not_found: 'We could not find that. It may have been deleted.',
  validation_failed: 'Some fields need attention. Check the messages next to them.',
  cannot_answer: 'This question cannot be answered from this file.',
  schema_mismatch: 'This file does not have the columns the template expects.',
  file_unsupported: 'This file is not a CSV or Excel (.xlsx) file we can read.',
  file_too_large: 'This file is too large to upload.',
  plan_limit: 'You have reached a limit of your plan.',
  dataset_not_ready: 'This file is not ready yet. Wait for it to finish, or try other read options.',
  dataset_expired: 'The source file was removed by the retention policy. Saved answers and reports are kept.',
  conflict: 'That cannot be done right now because something depends on it.',
  rate_limited: 'Too many requests in a short time. Wait a moment and try again.',
  llm_failed: 'The answer could not be produced this time. Nothing was saved. Please try again.',
  internal: 'Something went wrong on our side. Please try again.',
};

export const NETWORK_ERROR_MESSAGE = 'We could not reach the server. Check your connection and try again.';

export const PLAN_LABELS: Record<Plan, string> = {
  free: 'Free',
  solo: 'Solo',
  practice: 'Practice',
  practice_plus: 'Practice Plus',
};

const ERROR_CODES = new Set<string>(Object.keys(ERROR_MESSAGES));

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value);
}

/**
 * The contract only says "zod errors in details". The server sends { fields: [{ location, path, message }] }
 * (proposed for the contract in docs/CONTRACT_CHANGES.md). Anything else yields no field errors.
 */
export function fieldErrorsFrom(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!details || typeof details !== 'object') return out;
  const fields = (details as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return out;
  for (const item of fields) {
    if (!item || typeof item !== 'object') continue;
    const { path, message } = item as { path?: unknown; message?: unknown };
    if (typeof path === 'string' && path && typeof message === 'string' && !(path in out)) {
      out[path] = message;
    }
  }
  return out;
}
