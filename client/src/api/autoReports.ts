import { apiFetch } from './client';
import type { AutoReportRequest, AutoReportRun, ID } from './types';

/** POST /datasets/:id/auto-report (202 AutoReportRun, status 'running'). Flow B2. */
export function startAutoReport(datasetId: ID, body: AutoReportRequest): Promise<AutoReportRun> {
  return apiFetch<AutoReportRun>(`/datasets/${encodeURIComponent(datasetId)}/auto-report`, { method: 'POST', body });
}

/** GET /auto-reports/:id, polled every 2 s until done or failed. */
export function getAutoReport(id: ID, signal?: AbortSignal): Promise<AutoReportRun> {
  return apiFetch<AutoReportRun>(`/auto-reports/${encodeURIComponent(id)}`, { signal });
}
