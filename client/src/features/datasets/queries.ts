import { useRef } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteDataset,
  getDataset,
  getDatasetPreview,
  getDatasetQuality,
  getDatasetRows,
  listDatasets,
  reparseDataset,
  updateDataset,
  type RowsQuery,
} from '@/api/datasets';
import type { Dataset, DatasetDetail, DatasetStatus, ID, ReparseRequest, UpdateDatasetRequest } from '@/api/types';
import { meKey } from '@/auth/useMe';

export const DATASETS_PAGE_SIZE = 20;
export const PREVIEW_LIMIT = 50;

export const datasetKeys = {
  all: ['datasets'] as const,
  list: (workspaceId: ID) => ['datasets', 'list', workspaceId] as const,
  detail: (id: ID) => ['datasets', 'detail', id] as const,
  preview: (id: ID) => ['datasets', 'preview', id] as const,
  rows: (id: ID, query: RowsQuery) => ['datasets', 'preview', id, query] as const,
  quality: (id: ID) => ['datasets', 'quality', id] as const,
};

/** The list refreshes itself every 3 s while any dataset on it is still being read (paused when the tab is hidden). */
export const LIST_REFRESH_MS = 3000;

export function useDatasetList(workspaceId: ID | undefined) {
  return useInfiniteQuery({
    queryKey: datasetKeys.list(workspaceId ?? 'none'),
    enabled: Boolean(workspaceId),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      listDatasets(workspaceId as ID, { limit: DATASETS_PAGE_SIZE, offset: pageParam }, signal),
    getNextPageParam: (last) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) => p.items.some((d) => d.status === 'profiling' || d.status === 'uploading'))
        ? LIST_REFRESH_MS
        : false,
  });
}

// Polling while a dataset is being read (Flow A): every 1.5 s, slower after 3 minutes.
export const POLL_MS = 1500;
export const SLOW_POLL_MS = 10_000;
export const SLOW_AFTER_MS = 3 * 60_000;

export function nextPollDelay(status: DatasetStatus | undefined, elapsedMs: number): number | false {
  if (status !== 'profiling' && status !== 'uploading') return false;
  return elapsedMs >= SLOW_AFTER_MS ? SLOW_POLL_MS : POLL_MS;
}

/**
 * GET /datasets/:id, polled while profiling. Stops at ready or failed (or any other status), and when the
 * component unmounts (TanStack Query stops intervals with no observers). `isSlow` turns true after 3 minutes.
 */
export function useDatasetPolling(id: ID) {
  const startedAt = useRef<number | null>(null);
  const query = useQuery({
    queryKey: datasetKeys.detail(id),
    queryFn: ({ signal }) => getDataset(id, signal),
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      if (status !== 'profiling' && status !== 'uploading') {
        startedAt.current = null;
        return false;
      }
      startedAt.current ??= Date.now();
      return nextPollDelay(status, Date.now() - startedAt.current);
    },
  });
  // Reading dataUpdatedAt re-renders on every poll, so isSlow updates even when the data is unchanged.
  const updatedAt = query.dataUpdatedAt;
  const isSlow =
    (query.data?.status === 'profiling' || query.data?.status === 'uploading') &&
    startedAt.current !== null &&
    updatedAt - startedAt.current >= SLOW_AFTER_MS;
  return { ...query, isSlow };
}

export function useDatasetPreview(id: ID, enabled: boolean) {
  return useQuery({
    queryKey: datasetKeys.preview(id),
    queryFn: ({ signal }) => getDatasetPreview(id, PREVIEW_LIMIT, signal),
    enabled,
  });
}

export const ROWS_PAGE_SIZE = 50;

/**
 * One page of the Data tab. Each response carries the query it answers, and the previous page stays on screen
 * (placeholderData) while the next loads: the table only ever treats as current the rows whose query matches.
 */
export function useDatasetRows(id: ID, query: RowsQuery) {
  return useQuery({
    queryKey: datasetKeys.rows(id, query),
    queryFn: async ({ signal }) => ({ query, preview: await getDatasetRows(id, query, signal) }),
    placeholderData: keepPreviousData,
  });
}

/** The file's quality (Quality tab and its badge). Stored by the server, so it is fetched once per visit. */
export function useDatasetQuality(id: ID, enabled: boolean) {
  return useQuery({
    queryKey: datasetKeys.quality(id),
    queryFn: ({ signal }) => getDatasetQuality(id, signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

function useAfterChange() {
  const queryClient = useQueryClient();
  return (detail?: DatasetDetail) => {
    if (detail) queryClient.setQueryData(datasetKeys.detail(detail.id), detail);
    void queryClient.invalidateQueries({ queryKey: [...datasetKeys.all, 'list'] });
  };
}

export function useUpdateDataset(id: ID) {
  const after = useAfterChange();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateDatasetRequest) => updateDataset(id, body),
    onSuccess: (detail) => {
      after(detail);
      // Labels in the preview header follow display names; the server re-checks quality when a meaning or PII flag changes.
      void queryClient.invalidateQueries({ queryKey: datasetKeys.preview(id) });
      void queryClient.invalidateQueries({ queryKey: datasetKeys.quality(id) });
    },
  });
}

export function useReparseDataset(id: ID) {
  const queryClient = useQueryClient();
  const after = useAfterChange();
  return useMutation({
    mutationFn: (body: ReparseRequest) => reparseDataset(id, body),
    onSuccess: (dataset: Dataset) => {
      // Back to 'profiling': merge the summary so the page switches to the waiting state and polling restarts.
      queryClient.setQueryData<DatasetDetail>(datasetKeys.detail(id), (old) => (old ? { ...old, ...dataset } : old));
      queryClient.removeQueries({ queryKey: datasetKeys.preview(id) });
      queryClient.removeQueries({ queryKey: datasetKeys.quality(id) });
      after();
    },
  });
}

export function useDeleteDataset(id: ID) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deleteDataset(id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: datasetKeys.detail(id) });
      queryClient.removeQueries({ queryKey: datasetKeys.preview(id) });
      void queryClient.invalidateQueries({ queryKey: [...datasetKeys.all, 'list'] });
      void queryClient.invalidateQueries({ queryKey: meKey });
    },
  });
}
