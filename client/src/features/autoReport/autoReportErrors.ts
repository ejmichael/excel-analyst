import { errorMessage, isApiError } from '@/api/client';
import type { AutoReportConflictDetails, ID, PlanLimitDetails } from '@/api/types';
import { describeAskError } from '@/features/ask/askErrors';

/** How a failed "Build my report" start is shown. Every case is written out in words. */
export type StartErrorView =
  | { kind: 'plan_limit'; details: PlanLimitDetails }
  | { kind: 'running'; runId: ID }
  | { kind: 'fields'; title?: string; period_label?: string }
  | { kind: 'message'; message: string; offerAsk?: boolean };

export const ALREADY_RUNNING =
  'Analyst is already building a report from this file. It will appear in your reports when it is done.';
export const TOO_FEW_SUGGESTIONS =
  "This file doesn't have enough suggested questions yet to build a report. You can ask your own questions instead.";

export function describeStartError(error: unknown, dataset: { expires_at: string | null }): StartErrorView {
  if (!isApiError(error)) return { kind: 'message', message: errorMessage(error) };
  switch (error.code) {
    case 'plan_limit':
      return error.planLimit ? { kind: 'plan_limit', details: error.planLimit } : { kind: 'message', message: errorMessage(error) };
    case 'conflict': {
      // The server names the build already running for this file (AutoReportConflictDetails): show its progress.
      const runId = (error.details as Partial<AutoReportConflictDetails> | undefined)?.auto_report_id;
      return typeof runId === 'string' ? { kind: 'running', runId } : { kind: 'message', message: ALREADY_RUNNING };
    }
    case 'dataset_not_ready':
    case 'dataset_expired': {
      // Same words as asking a question (Part 2).
      const view = describeAskError(error, dataset);
      return { kind: 'message', message: 'message' in view ? view.message : errorMessage(error) };
    }
    case 'validation_failed': {
      // A field error is about the title or period; otherwise the file has fewer than 3 suggestions (Flow B2).
      const { title, period_label } = error.fieldErrors;
      if (title || period_label) return { kind: 'fields', title, period_label };
      return { kind: 'message', message: TOO_FEW_SUGGESTIONS, offerAsk: true };
    }
    default:
      return { kind: 'message', message: errorMessage(error) };
  }
}
