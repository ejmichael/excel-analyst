import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getMe, updateMe } from '@/api/me';
import type { Me, UpdateMeRequest } from '@/api/types';
import { useSession } from './SessionProvider';

export const meKey = ['me'] as const;

export function useMe() {
  const { session } = useSession();
  return useQuery({
    queryKey: meKey,
    queryFn: ({ signal }) => getMe(signal),
    enabled: session !== null,
  });
}

export function useUpdateMe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMeRequest) => updateMe(body),
    onSuccess: (me: Me) => queryClient.setQueryData(meKey, me),
  });
}
