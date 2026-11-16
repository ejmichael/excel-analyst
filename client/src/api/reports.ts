import { apiDownload, apiFetch, apiUpload, type Download } from './client';
import type {
  Brand,
  CreateShareLinkRequest,
  CreateReportRequest,
  Deleted,
  ID,
  Paged,
  Report,
  ReportDetail,
  ShareLink,
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

/** GET /reports/:id/export.xlsx: the file itself (name from Content-Disposition). Counts as an export. */
export function downloadReportXlsx(id: ID): Promise<Download> {
  return apiDownload(`/reports/${encodeURIComponent(id)}/export.xlsx`);
}

/** GET /reports/:id/share-links (newest first; the owner sees each link's url) */
export function listShareLinks(reportId: ID, signal?: AbortSignal): Promise<ShareLink[]> {
  return apiFetch<ShareLink[]>(`/reports/${encodeURIComponent(reportId)}/share-links`, { signal });
}

/** POST /reports/:id/share-links (201; needs limits.share_links, else 402) */
export function createShareLink(reportId: ID, body: CreateShareLinkRequest): Promise<ShareLink> {
  return apiFetch<ShareLink>(`/reports/${encodeURIComponent(reportId)}/share-links`, { method: 'POST', body });
}

/** DELETE /share-links/:id: turns the link off (sets revoked_at) and returns it */
export function revokeShareLink(id: ID): Promise<ShareLink> {
  return apiFetch<ShareLink>(`/share-links/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
