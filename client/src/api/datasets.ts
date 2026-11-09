import { apiFetch, apiUpload } from './client';
import type {
  Dataset,
  DatasetDetail,
  DatasetPreview,
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

/** GET /datasets/:id/preview?limit= (needs 'ready') */
export function getDatasetPreview(id: ID, limit: number, signal?: AbortSignal): Promise<DatasetPreview> {
  return apiFetch<DatasetPreview>(`/datasets/${encodeURIComponent(id)}/preview?limit=${limit}`, { signal });
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
