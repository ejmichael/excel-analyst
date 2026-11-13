import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createReport, deleteReport, getReport, listReports, updateReport } from '@/api/reports';
import type { CreateReportRequest, ID, ReportDetail, UpdateReportRequest } from '@/api/types';
import { meKey } from '@/auth/useMe';

export const REPORTS_PAGE_SIZE = 20;

export const reportKeys = {
  all: ['reports'] as const,
  list: (workspaceId: ID) => ['reports', 'list', workspaceId] as const,
  detail: (id: ID) => ['reports', 'detail', id] as const,
};

export function useReportsList(workspaceId: ID | undefined) {
  return useInfiniteQuery({
    queryKey: reportKeys.list(workspaceId ?? 'none'),
    enabled: Boolean(workspaceId),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => listReports(workspaceId as ID, { limit: REPORTS_PAGE_SIZE, offset: pageParam }, signal),
    getNextPageParam: (last) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
  });
}

export function useReport(id: ID) {
  return useQuery({ queryKey: reportKeys.detail(id), queryFn: ({ signal }) => getReport(id, signal) });
}

export function useCreateReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateReportRequest) => createReport(body),
    onSuccess: (report: ReportDetail) => {
      queryClient.setQueryData(reportKeys.detail(report.id), report);
      void queryClient.invalidateQueries({ queryKey: reportKeys.list(report.workspace_id) });
      // The monthly report count changed.
      void queryClient.invalidateQueries({ queryKey: meKey });
    },
  });
}

export function useUpdateReport(id: ID) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateReportRequest) => updateReport(id, body),
    onSuccess: (report: ReportDetail) => {
      queryClient.setQueryData(reportKeys.detail(id), report);
      void queryClient.invalidateQueries({ queryKey: reportKeys.list(report.workspace_id) });
    },
  });
}

export function useDeleteReport(id: ID, workspaceId: ID | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deleteReport(id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: reportKeys.detail(id) });
      if (workspaceId) void queryClient.invalidateQueries({ queryKey: reportKeys.list(workspaceId) });
    },
  });
}
