import { API_BASE, env } from '@/env';
import { mockTransport } from './mocks/handlers';
import type { Transport } from './client';
import type { PublicReport } from './types';

/**
 * The public report page talks to GET /public/reports/:token with a plain request: never the authenticated API
 * client, never an Authorization header, no cookies, no referrer and no cache. Nothing is stored.
 */
let transport: Transport = env.useMocks ? mockTransport : (url, init) => fetch(url, init);

/** For tests: swap the transport (to check what is sent). */
export function configurePublicTransport(next: Transport): void {
  transport = next;
}

export type PublicReportFailure =
  | { kind: 'unavailable' } // 404: unknown, expired or turned off; the page never says which
  | { kind: 'rate_limited'; retryAfterSeconds: number | null }
  | { kind: 'network' }
  | { kind: 'error' };

export class PublicReportError extends Error {
  constructor(readonly failure: PublicReportFailure) {
    super(failure.kind);
    this.name = 'PublicReportError';
  }
}

export async function getPublicReport(token: string, signal?: AbortSignal): Promise<PublicReport> {
  let response: Response;
  try {
    response = await transport(`${API_BASE}/public/reports/${encodeURIComponent(token)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new PublicReportError({ kind: 'network' });
  }
  if (response.status === 404) throw new PublicReportError({ kind: 'unavailable' });
  if (response.status === 429) {
    const seconds = Number(response.headers.get('Retry-After'));
    throw new PublicReportError({ kind: 'rate_limited', retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null });
  }
  if (!response.ok) throw new PublicReportError({ kind: 'error' });
  const body = (await response.json().catch(() => null)) as { data?: PublicReport } | null;
  if (!body?.data) throw new PublicReportError({ kind: 'error' });
  return body.data;
}
