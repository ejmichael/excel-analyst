import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { isApiError } from '@/api/client';
import { getDashboard, getDashboardData, planDashboard } from '@/api/dashboards';
import type { Dashboard, DashboardFilterValue, ID } from '@/api/types';

export const dashboardKeys = {
  all: (datasetId: ID) => ['dashboards', datasetId] as const,
  dashboard: (datasetId: ID) => ['dashboards', datasetId, 'dashboard'] as const,
  data: (datasetId: ID) => ['dashboards', datasetId, 'data'] as const,
  dataFor: (datasetId: ID, dashboard: Pick<Dashboard, 'id' | 'created_at'>, filters: DashboardFilterValue[]) =>
    ['dashboards', datasetId, 'data', dashboard.id, dashboard.created_at, filters] as const,
};

/** The contract: poll GET every 2 s while the dashboard is planning. */
export const PLANNING_POLL_MS = 2000;
/** After this long planning, the card says it is taking longer than usual. */
export const PLANNING_SLOW_MS = 60_000;

/**
 * Per query cache (one per app session): the datasets whose dashboard this session has already asked the server to
 * plan on its own, and when it first saw each one planning. Kept outside React so strict mode's double effects, a
 * remount or leaving the tab and coming back can never send the costly POST twice, or restart the 60 s clock.
 */
const autoPlanned = new WeakMap<QueryClient, Set<ID>>();
const planningSince = new WeakMap<QueryClient, Map<ID, number>>();

/** True the first time it is called for this dataset in this query cache, false ever after. */
export function claimAutoPlan(client: QueryClient, datasetId: ID): boolean {
  let claimed = autoPlanned.get(client);
  if (!claimed) autoPlanned.set(client, (claimed = new Set()));
  if (claimed.has(datasetId)) return false;
  claimed.add(datasetId);
  return true;
}

/** When this session first saw the dashboard planning (null when it is not planning). */
function trackPlanning(client: QueryClient, datasetId: ID, planning: boolean): number | null {
  let since = planningSince.get(client);
  if (!since) planningSince.set(client, (since = new Map()));
  if (!planning) {
    since.delete(datasetId);
    return null;
  }
  if (!since.has(datasetId)) since.set(datasetId, Date.now());
  return since.get(datasetId)!;
}

/**
 * GET /datasets/:id/dashboard. `null` means there is none yet (the server's 404). Polled every 2 s while planning;
 * polling stops when the tab unmounts and resumes when it comes back (a planning dashboard is always refetched).
 */
export function useDashboard(datasetId: ID) {
  return useQuery({
    queryKey: dashboardKeys.dashboard(datasetId),
    queryFn: async ({ signal }) => {
      try {
        return await getDashboard(datasetId, signal);
      } catch (error) {
        if (isApiError(error) && error.status === 404) return null;
        throw error;
      }
    },
    staleTime: (query) => (query.state.data?.status === 'planning' ? 0 : 30_000),
    refetchInterval: (query) => (query.state.data?.status === 'planning' ? PLANNING_POLL_MS : false),
  });
}

export const planMutationKey = (datasetId: ID) => ['dashboards', datasetId, 'plan'] as const;

/** POST /datasets/:id/dashboard: the planned dashboard (status 'planning') replaces the cached one, and polling starts. */
export function usePlanDashboard(datasetId: ID) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: planMutationKey(datasetId),
    mutationFn: () => planDashboard(datasetId),
    // Kept, so a failed request still shows (with Try again) when the tab is opened again later.
    gcTime: Infinity,
    onSuccess: (dashboard) => {
      client.setQueryData(dashboardKeys.dashboard(datasetId), dashboard);
      client.removeQueries({ queryKey: dashboardKeys.data(datasetId) });
    },
  });
}

/** True once the dashboard has been planning for 60 s in this session (re-renders when that moment comes). */
export function usePlanningSlow(datasetId: ID, planning: boolean): boolean {
  const client = useQueryClient();
  const since = trackPlanning(client, datasetId, planning);
  const [, setTick] = useState(0);
  const remaining = since === null ? null : since + PLANNING_SLOW_MS - Date.now();
  useEffect(() => {
    if (remaining === null || remaining <= 0) return;
    const timer = setTimeout(() => setTick((t) => t + 1), remaining);
    return () => clearTimeout(timer);
  }, [remaining]);
  return remaining !== null && remaining <= 0;
}

/**
 * POST /datasets/:id/dashboard/data for one set of filters. Each response carries the filters it answers; the previous
 * results stay on screen (placeholderData) while the next load, and only a response whose filters match the current
 * ones is treated as current.
 */
export function useDashboardData(datasetId: ID, dashboard: Dashboard | null, filters: DashboardFilterValue[]) {
  return useQuery({
    queryKey: dashboard ? dashboardKeys.dataFor(datasetId, dashboard, filters) : [...dashboardKeys.data(datasetId), 'none'],
    queryFn: async ({ signal }) => ({ filters, data: await getDashboardData(datasetId, { filters }, signal) }),
    enabled: dashboard?.status === 'ready',
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
}
