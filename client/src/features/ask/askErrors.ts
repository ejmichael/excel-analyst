import { isApiError } from '@/api/client';
import type { PlanLimitDetails } from '@/api/types';
import { ERROR_MESSAGES } from '@/lib/errors';
import { formatDate, formatNumber } from '@/lib/format';

/** How a failed ask is shown. Every case is written out in words. */
export type AskErrorView =
  | { kind: 'field'; message: string }
  | { kind: 'cannot_answer'; message: string }
  | { kind: 'plan_limit'; details: PlanLimitDetails }
  | { kind: 'not_ready'; message: string }
  | { kind: 'expired'; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'general'; message: string };

export function describeAskError(error: unknown, dataset: { expires_at: string | null }): AskErrorView {
  if (!isApiError(error)) return { kind: 'general', message: ERROR_MESSAGES.internal };
  switch (error.code) {
    case 'validation_failed':
      return { kind: 'field', message: error.fieldErrors.question ?? 'Write a question of 3 to 500 characters.' };
    case 'cannot_answer':
      // The server's message says what is missing from the file; it is written for the user.
      return { kind: 'cannot_answer', message: error.serverMessage ?? ERROR_MESSAGES.cannot_answer };
    case 'plan_limit':
      return error.planLimit ? { kind: 'plan_limit', details: error.planLimit } : { kind: 'general', message: error.message };
    case 'dataset_not_ready':
      return { kind: 'not_ready', message: 'This file is not ready for questions yet. Open the file to see how it is going.' };
    case 'dataset_expired':
      return {
        kind: 'expired',
        message: dataset.expires_at
          ? `The original file was deleted on ${formatDate(dataset.expires_at)}. You can still read your earlier answers.`
          : 'The original file was deleted. You can still read your earlier answers.',
      };
    case 'rate_limited':
      return {
        kind: 'general',
        message: error.retryAfterSeconds
          ? `You're asking quickly; wait ${formatNumber(error.retryAfterSeconds, 0)} seconds and try again.`
          : "You're asking quickly; wait a moment and try again.",
      };
    case 'llm_failed':
      return { kind: 'general', message: "We couldn't get an answer just now. Nothing was used from your allowance. Try again." };
    default:
      if (error.status === 0) {
        return {
          kind: 'network',
          message: 'The connection dropped while we were answering. If the answer was finished, it is in your history below.',
        };
      }
      // Never the server's own text here: it could contain internals such as SQL errors.
      return { kind: 'general', message: ERROR_MESSAGES[error.code] ?? ERROR_MESSAGES.internal };
  }
}
