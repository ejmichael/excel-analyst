import { apiFetch } from './client';
import type { Me, UpdateMeRequest } from './types';

/** GET /me (allowed before consent). */
export function getMe(signal?: AbortSignal): Promise<Me> {
  return apiFetch<Me>('/me', { signal });
}

/** PATCH /me (allowed before consent; `accept_terms: true` gives consent). */
export function updateMe(body: UpdateMeRequest): Promise<Me> {
  return apiFetch<Me>('/me', { method: 'PATCH', body });
}
