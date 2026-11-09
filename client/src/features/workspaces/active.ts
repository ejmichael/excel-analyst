import type { ID, Workspace } from '@/api/types';

export const ACTIVE_WORKSPACE_KEY = 'analyst.active-workspace';

/** The stored workspace if it still exists, else the default one, else the first. */
export function pickActiveWorkspace(workspaces: Workspace[], storedId: ID | null): Workspace | null {
  return (
    (storedId ? workspaces.find((w) => w.id === storedId) : undefined) ??
    workspaces.find((w) => w.is_default) ??
    workspaces[0] ??
    null
  );
}
