import { errorMessage, isApiError } from '@/api/client';

/**
 * What went wrong with a dashboard request, in words, and whether a Try again button could help. A 429 keeps the
 * server's message and is never retried on its own; on the planning request (a daily limit) it offers no button.
 */
export function dashboardError(error: unknown, { planning = false } = {}): { text: string; canRetry: boolean } {
  if (isApiError(error)) {
    if (error.code === 'dataset_not_ready') return { text: 'This file is still being read. Try again in a moment.', canRetry: true };
    if (error.code === 'dataset_expired') return { text: 'This file has expired, so its dashboard can no longer be shown.', canRetry: false };
    if (error.code === 'rate_limited') return { text: error.serverMessage ?? error.message, canRetry: !planning };
  }
  return { text: errorMessage(error), canRetry: true };
}
