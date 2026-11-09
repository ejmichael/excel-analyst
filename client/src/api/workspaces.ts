import { apiFetch } from './client';
import type { CreateWorkspaceRequest, Deleted, ID, UpdateWorkspaceRequest, Workspace } from './types';

/** GET /workspaces */
export function listWorkspaces(signal?: AbortSignal): Promise<Workspace[]> {
  return apiFetch<Workspace[]>('/workspaces', { signal });
}

/** POST /workspaces (402 plan_limit on max_workspaces) */
export function createWorkspace(body: CreateWorkspaceRequest): Promise<Workspace> {
  return apiFetch<Workspace>('/workspaces', { method: 'POST', body });
}

/** PATCH /workspaces/:id */
export function updateWorkspace(id: ID, body: UpdateWorkspaceRequest): Promise<Workspace> {
  return apiFetch<Workspace>(`/workspaces/${encodeURIComponent(id)}`, { method: 'PATCH', body });
}

/** DELETE /workspaces/:id (409 conflict for the default workspace) */
export function deleteWorkspace(id: ID): Promise<Deleted> {
  return apiFetch<Deleted>(`/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
