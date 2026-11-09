import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@/api/client';
import { uploadDataset } from '@/api/datasets';
import type { Dataset, ID, PlanLimitDetails, PlanLimits } from '@/api/types';
import { meKey } from '@/auth/useMe';
import type { LocalPlanLimit } from '@/components/UpgradeDialog';
import { ERROR_MESSAGES } from '@/lib/errors';
import { datasetKeys } from './queries';
import { checkFile } from './uploadValidation';

export type UploadState =
  | { phase: 'idle' }
  | { phase: 'selected'; file: File }
  | { phase: 'uploading'; file: File; progress: number }
  | { phase: 'error'; file: File | null; message: string };

/** Upload errors in words, with the specifics each code needs. */
export function uploadErrorMessage(error: unknown): string {
  if (!isApiError(error)) return ERROR_MESSAGES.internal;
  switch (error.code) {
    case 'file_too_large':
      return 'This file is larger than the 50 MB any plan accepts. Split it into smaller files, or remove columns you do not need.';
    case 'file_unsupported':
      return 'We could not read this as a CSV or Excel (.xlsx) file. Export it again from your system as CSV or .xlsx and try again.';
    case 'rate_limited':
      return error.retryAfterSeconds
        ? `Too many uploads in a short time. Wait ${error.retryAfterSeconds} seconds and try again.`
        : ERROR_MESSAGES.rate_limited;
    default:
      return error.message;
  }
}

interface Options {
  workspaceId: ID | undefined;
  limits: PlanLimits | undefined;
  onUploaded: (dataset: Dataset) => void;
}

export function useUpload({ workspaceId, limits, onUploaded }: Options) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<UploadState>({ phase: 'idle' });
  const [planLimit, setPlanLimit] = useState<PlanLimitDetails | LocalPlanLimit | null>(null);
  const controller = useRef<AbortController | null>(null);

  // Leaving the page cancels an upload in flight.
  useEffect(() => () => controller.current?.abort(), []);

  const select = useCallback(
    (file: File) => {
      if (!limits) return;
      const check = checkFile(file, limits);
      if (check.ok) return setState({ phase: 'selected', file });
      if (check.reason === 'size') {
        setState({ phase: 'idle' });
        return setPlanLimit(check.limit);
      }
      setState({ phase: 'error', file: null, message: check.message });
    },
    [limits],
  );

  const start = useCallback(
    async (name?: string) => {
      if (state.phase !== 'selected' || !workspaceId) return;
      const { file } = state;
      const abort = new AbortController();
      controller.current = abort;
      setState({ phase: 'uploading', file, progress: 0 });
      try {
        const dataset = await uploadDataset(
          { file, workspace_id: workspaceId, name },
          {
            signal: abort.signal,
            onProgress: (progress) => setState((s) => (s.phase === 'uploading' ? { ...s, progress } : s)),
          },
        );
        void queryClient.invalidateQueries({ queryKey: datasetKeys.list(workspaceId) });
        void queryClient.invalidateQueries({ queryKey: meKey });
        setState({ phase: 'idle' });
        onUploaded(dataset);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          setState({ phase: 'selected', file });
          return;
        }
        if (isApiError(error) && error.planLimit) {
          setState({ phase: 'selected', file });
          setPlanLimit(error.planLimit);
          return;
        }
        setState({ phase: 'error', file, message: uploadErrorMessage(error) });
      } finally {
        controller.current = null;
      }
    },
    [state, workspaceId, queryClient, onUploaded],
  );

  return {
    state,
    planLimit,
    closePlanLimit: () => setPlanLimit(null),
    select,
    start,
    cancel: () => controller.current?.abort(),
    reset: () => setState({ phase: 'idle' }),
  };
}
