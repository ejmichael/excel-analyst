import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ID } from '@/api/types';
import { createWorkspace, deleteWorkspace, listWorkspaces, updateWorkspace } from '@/api/workspaces';
import { meKey } from '@/auth/useMe';

export const workspacesKey = ['workspaces'] as const;

export function useWorkspaces() {
  return useQuery({ queryKey: workspacesKey, queryFn: ({ signal }) => listWorkspaces(signal) });
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: workspacesKey });
    // Me.usage.workspaces changes too.
    void queryClient.invalidateQueries({ queryKey: meKey });
  };
}

export function useCreateWorkspace() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (name: string) => createWorkspace({ name }), onSuccess: refresh });
}

export function useRenameWorkspace() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, name }: { id: ID; name: string }) => updateWorkspace(id, { name }),
    onSuccess: refresh,
  });
}

export function useDeleteWorkspace() {
  const refresh = useRefresh();
  return useMutation({ mutationFn: (id: ID) => deleteWorkspace(id), onSuccess: refresh });
}
