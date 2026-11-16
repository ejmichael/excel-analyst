import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createShareLink, listShareLinks, revokeShareLink } from '@/api/reports';
import type { CreateShareLinkRequest, ID, ShareLink } from '@/api/types';

export const shareLinkKeys = {
  list: (reportId: ID) => ['share-links', reportId] as const,
};

export function useShareLinks(reportId: ID, enabled: boolean) {
  return useQuery({
    queryKey: shareLinkKeys.list(reportId),
    queryFn: ({ signal }) => listShareLinks(reportId, signal),
    enabled,
  });
}

/** Puts a new or changed link into the cached list (newest first), so the list updates without a reload. */
function upsert(list: ShareLink[] | undefined, link: ShareLink): ShareLink[] {
  const items = list ?? [];
  return items.some((l) => l.id === link.id) ? items.map((l) => (l.id === link.id ? link : l)) : [link, ...items];
}

export function useCreateShareLink(reportId: ID) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateShareLinkRequest) => createShareLink(reportId, body),
    onSuccess: (link) => queryClient.setQueryData<ShareLink[]>(shareLinkKeys.list(reportId), (list) => upsert(list, link)),
  });
}

export function useRevokeShareLink(reportId: ID) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: ID) => revokeShareLink(id),
    onSuccess: (link) => queryClient.setQueryData<ShareLink[]>(shareLinkKeys.list(reportId), (list) => upsert(list, link)),
  });
}

export type LinkStatus = 'active' | 'expired' | 'off';

/** A link works while it is not turned off and its expiry (if any) is still ahead. */
export function linkStatus(link: Pick<ShareLink, 'revoked_at' | 'expires_at'>, now = Date.now()): LinkStatus {
  if (link.revoked_at) return 'off';
  if (link.expires_at && Date.parse(link.expires_at) <= now) return 'expired';
  return 'active';
}

export const STATUS_WORDS: Record<LinkStatus, string> = { active: 'Active', expired: 'Expired', off: 'Turned off' };
