import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getAutoReport, startAutoReport } from '@/api/autoReports';
import type { AutoReportRequest, AutoReportRun, ID } from '@/api/types';
import { meKey } from '@/auth/useMe';
import { blockKeys } from '@/features/ask/queries';
import { reportKeys } from '@/features/reports/queries';
import { runStore } from './runStore';

export const autoReportKey = (id: ID) => ['auto-reports', id] as const;

// Flow B2: poll every 2 s while running; after 3 minutes say so and poll more slowly.
export const AUTO_POLL_MS = 2000;
export const AUTO_SLOW_POLL_MS = 10_000;
export const AUTO_SLOW_AFTER_MS = 3 * 60_000;

export function nextAutoReportPoll(status: AutoReportRun['status'] | undefined, elapsedMs: number): number | false {
  if (status !== 'running') return false;
  return elapsedMs >= AUTO_SLOW_AFTER_MS ? AUTO_SLOW_POLL_MS : AUTO_POLL_MS;
}

/**
 * GET /auto-reports/:id, polled while running. Stops at done or failed, and when the page is left (TanStack Query
 * stops intervals with no observers). `isSlow` turns true 3 minutes after the run started.
 */
export function useAutoReportRun(id: ID, startedAt: number) {
  const query = useQuery({
    queryKey: autoReportKey(id),
    queryFn: ({ signal }) => getAutoReport(id, signal),
    refetchInterval: (q) => nextAutoReportPoll(q.state.data?.status, Date.now() - startedAt),
    // A 404 means the run is gone; no point asking again.
    retry: false,
  });
  // dataUpdatedAt changes on every poll, so isSlow updates even when the data is unchanged.
  const isSlow = query.data?.status === 'running' && query.dataUpdatedAt - startedAt >= AUTO_SLOW_AFTER_MS;
  return { ...query, isSlow };
}

/** POST /datasets/:id/auto-report; remembers the run for this dataset so the page can show its progress. */
export function useStartAutoReport(datasetId: ID) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: AutoReportRequest) => startAutoReport(datasetId, request),
    onSuccess: (run, request) => {
      queryClient.setQueryData(autoReportKey(run.id), run);
      runStore.set(datasetId, { run_id: run.id, request, started_at: Date.now() });
    },
  });
}

/** After a run finishes: usage, the reports list and the file's answers have all changed. */
export function useAfterRun(datasetId: ID) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: meKey });
    void queryClient.invalidateQueries({ queryKey: reportKeys.all });
    void queryClient.invalidateQueries({ queryKey: blockKeys.history(datasetId) });
  };
}
