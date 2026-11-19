import { apiFetch, apiUpload } from './client';
import type {
  Dataset,
  DatasetDetail,
  DatasetPreview,
  DatasetQuality,
  Deleted,
  ID,
  Paged,
  ReparseRequest,
  UpdateDatasetRequest,
} from './types';

/** GET /datasets?workspace_id=&limit=&offset= (newest first) */
export function listDatasets(
  workspaceId: ID,
  { limit, offset }: { limit: number; offset: number },
  signal?: AbortSignal,
): Promise<Paged<Dataset>> {
  const query = new URLSearchParams({ workspace_id: workspaceId, limit: String(limit), offset: String(offset) });
  return apiFetch<Paged<Dataset>>(`/datasets?${query}`, { signal });
}

/** GET /datasets/:id */
export function getDataset(id: ID, signal?: AbortSignal): Promise<DatasetDetail> {
  return apiFetch<DatasetDetail>(`/datasets/${encodeURIComponent(id)}`, { signal });
}

/** PATCH /datasets/:id */
export function updateDataset(id: ID, body: UpdateDatasetRequest): Promise<DatasetDetail> {
  return apiFetch<DatasetDetail>(`/datasets/${encodeURIComponent(id)}`, { method: 'PATCH', body });
}

/** POST /datasets/:id/reparse (202, status back to 'profiling') */
export function reparseDataset(id: ID, body: ReparseRequest): Promise<Dataset> {
  return apiFetch<Dataset>(`/datasets/${encodeURIComponent(id)}/reparse`, { method: 'POST', body });
}

export interface RowsQuery {
  limit: number;
  offset: number;
  /** A column's sql_name, or null for the file's own order. */
  sort: string | null;
  dir: 'asc' | 'desc';
  /** Kept to rows where any text column contains it; empty for no search. */
  q: string;
}

/** GET /datasets/:id/preview?limit=&offset=&sort=&dir=&q= (needs 'ready'): a page of the file's rows. */
export function getDatasetRows(id: ID, query: RowsQuery, signal?: AbortSignal): Promise<DatasetPreview> {
  const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) });
  if (query.sort) {
    params.set('sort', query.sort);
    params.set('dir', query.dir);
  }
  if (query.q) params.set('q', query.q);
  return apiFetch<DatasetPreview>(`/datasets/${encodeURIComponent(id)}/preview?${params}`, { signal });
}

/** GET /datasets/:id/quality (needs 'ready'; the first call can take a few seconds) */
export function getDatasetQuality(id: ID, signal?: AbortSignal): Promise<DatasetQuality> {
  return apiFetch<DatasetQuality>(`/datasets/${encodeURIComponent(id)}/quality`, { signal });
}

/** DELETE /datasets/:id */
export function deleteDataset(id: ID): Promise<Deleted> {
  return apiFetch<Deleted>(`/datasets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface UploadDatasetInput {
  file: File;
  workspace_id: ID;
  name?: string;
}

/** POST /datasets (multipart: file, workspace_id, name?). 201 Dataset with status 'profiling'. */
export function uploadDataset(
  { file, workspace_id, name }: UploadDatasetInput,
  options: { onProgress: (fraction: number) => void; signal: AbortSignal },
): Promise<Dataset> {
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('workspace_id', workspace_id);
  if (name?.trim()) form.append('name', name.trim());
  return apiUpload<Dataset>('/datasets', form, options);
}
