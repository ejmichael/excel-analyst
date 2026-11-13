import { apiFetch, apiUpload } from './client';
import type {
  Brand,
  CreateReportRequest,
  Deleted,
  ID,
  Paged,
  Report,
  ReportDetail,
  UpdateReportRequest,
} from './types';

/** GET /reports?workspace_id=&limit=&offset= (newest first) */
export function listReports(
  workspaceId: ID,
  { limit, offset }: { limit: number; offset: number },
  signal?: AbortSignal,
): Promise<Paged<Report>> {
  const query = new URLSearchParams({ workspace_id: workspaceId, limit: String(limit), offset: String(offset) });
  return apiFetch<Paged<Report>>(`/reports?${query}`, { signal });
}

/** POST /reports (201 ReportDetail; limit max_reports_per_month; 1 to 30 answers from this workspace) */
export function createReport(body: CreateReportRequest): Promise<ReportDetail> {
  return apiFetch<ReportDetail>('/reports', { method: 'POST', body });
}

/** GET /reports/:id */
export function getReport(id: ID, signal?: AbortSignal): Promise<ReportDetail> {
  return apiFetch<ReportDetail>(`/reports/${encodeURIComponent(id)}`, { signal });
}

/** PATCH /reports/:id (`blocks` replaces membership and order) */
export function updateReport(id: ID, body: UpdateReportRequest): Promise<ReportDetail> {
  return apiFetch<ReportDetail>(`/reports/${encodeURIComponent(id)}`, { method: 'PATCH', body });
}

/** DELETE /reports/:id (the answers themselves are kept) */
export function deleteReport(id: ID): Promise<Deleted> {
  return apiFetch<Deleted>(`/reports/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** POST /me/logo (multipart `file`; png, jpg or webp, max 1 MB; needs limits.branding) */
export function uploadLogo(file: File, options: { onProgress: (fraction: number) => void; signal: AbortSignal }): Promise<Brand> {
  const form = new FormData();
  form.append('file', file, file.name);
  return apiUpload<Brand>('/me/logo', form, options);
}

/** DELETE /me/logo */
export function deleteLogo(): Promise<Brand> {
  return apiFetch<Brand>('/me/logo', { method: 'DELETE' });
}
