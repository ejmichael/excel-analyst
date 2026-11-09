import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ID, Workspace } from '@/api/types';
import { readStored, writeStored } from '@/lib/storage';
import { ACTIVE_WORKSPACE_KEY, pickActiveWorkspace } from './active';
import { useWorkspaces } from './queries';

interface WorkspaceContextValue {
  workspaces: Workspace[];
  active: Workspace | null;
  setActiveId: (id: ID) => void;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const query = useWorkspaces();
  // React state is the source of truth; localStorage only remembers it between visits.
  const [selectedId, setSelectedId] = useState<ID | null>(() => readStored(ACTIVE_WORKSPACE_KEY));

  const workspaces = useMemo(() => query.data ?? [], [query.data]);
  const active = useMemo(() => pickActiveWorkspace(workspaces, selectedId), [workspaces, selectedId]);

  const setActiveId = useCallback((id: ID) => {
    setSelectedId(id);
    writeStored(ACTIVE_WORKSPACE_KEY, id);
  }, []);

  const value = useMemo(
    () => ({
      workspaces,
      active,
      setActiveId,
      isLoading: query.isPending,
      error: query.error,
      refetch: () => void query.refetch(),
    }),
    [workspaces, active, setActiveId, query],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useActiveWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useActiveWorkspace must be used inside WorkspaceProvider');
  return value;
}
