import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { askQuestion, deleteBlock, getSourceRows, listBlocks, sendBlockFeedback } from '@/api/blocks';
import type { AskRequest, Block, ID, Paged } from '@/api/types';
import { meKey } from '@/auth/useMe';

export const HISTORY_PAGE_SIZE = 20;
export const SOURCE_ROWS_PAGE_SIZE = 50;

export const blockKeys = {
  history: (datasetId: ID) => ['blocks', 'history', datasetId] as const,
  sourceRows: (blockId: ID) => ['blocks', 'source-rows', blockId] as const,
};

export function useAnswerHistory(datasetId: ID) {
  return useInfiniteQuery({
    queryKey: blockKeys.history(datasetId),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => listBlocks(datasetId, { limit: HISTORY_PAGE_SIZE, offset: pageParam }, signal),
    getNextPageParam: (last) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
  });
}

export function useAsk(datasetId: ID) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AskRequest) => askQuestion(datasetId, body),
    onSettled: () => {
      // The answer is saved (or the quota changed) on the server; even after a dropped connection the
      // answer may be there, so history and the question count are always reloaded.
      void queryClient.invalidateQueries({ queryKey: blockKeys.history(datasetId) });
      void queryClient.invalidateQueries({ queryKey: meKey });
    },
  });
}

/** Loaded only when asked for ("Show the rows this is based on"), then paged with "Load more". */
export function useSourceRows(blockId: ID, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: blockKeys.sourceRows(blockId),
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => getSourceRows(blockId, { limit: SOURCE_ROWS_PAGE_SIZE, offset: pageParam }, signal),
    getNextPageParam: (last) => (last.offset + last.rows.length < last.total ? last.offset + last.rows.length : undefined),
  });
}

export function useDeleteBlock(block: Pick<Block, 'id' | 'dataset_id'>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deleteBlock(block.id),
    onSuccess: () => {
      if (!block.dataset_id) return;
      const key = blockKeys.history(block.dataset_id);
      // Take it out of the cached history at once (no flash of the deleted answer), then reload.
      queryClient.setQueryData<InfiniteData<Paged<Block>>>(key, (data) =>
        data ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.filter((b) => b.id !== block.id) })) } : data,
      );
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

export function useBlockFeedback(blockId: ID) {
  return useMutation({ mutationFn: (note: string) => sendBlockFeedback(blockId, { kind: 'looks_wrong', ...(note.trim() ? { note: note.trim() } : {}) }) });
}
