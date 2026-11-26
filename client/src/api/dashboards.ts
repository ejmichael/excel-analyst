import { apiFetch, apiFetchWithStatus } from './client';
import type { Dashboard, DashboardData, DashboardDataRequest, ID, Report, SaveDashboardToReportRequest } from './types';

const base = (datasetId: ID) => `/datasets/${encodeURIComponent(datasetId)}/dashboard`;

/** GET /datasets/:id/dashboard (404 not_found until the first POST) */
export function getDashboard(datasetId: ID, signal?: AbortSignal): Promise<Dashboard> {
  return apiFetch<Dashboard>(base(datasetId), { signal });
}

/** POST /datasets/:id/dashboard (202, status 'planning'): one model call, so only on first open, Try again or Rebuild. */
export function planDashboard(datasetId: ID): Promise<Dashboard> {
  return apiFetch<Dashboard>(base(datasetId), { method: 'POST' });
}

/** POST /datasets/:id/dashboard/data: every widget run again under the filters (never calls the model). */
export function getDashboardData(datasetId: ID, body: DashboardDataRequest, signal?: AbortSignal): Promise<DashboardData> {
  return apiFetch<DashboardData>(`${base(datasetId)}/data`, { method: 'POST', body, signal });
}

/**
 * POST /datasets/:id/dashboard/save-to-report: the widgets, run again by the server under the filters, become answers
 * in a new report (201) or are added to an existing one (200). Never calls the model; only ids and filters are sent.
 */
export async function saveDashboardToReport(
  datasetId: ID,
  body: SaveDashboardToReportRequest,
): Promise<{ report: Report; created: boolean }> {
  const { data, status } = await apiFetchWithStatus<Report>(`${base(datasetId)}/save-to-report`, { method: 'POST', body });
  return { report: data, created: status === 201 };
}
