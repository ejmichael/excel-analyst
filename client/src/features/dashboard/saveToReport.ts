import { isApiError } from '@/api/client';
import type { DashboardFilter, DashboardFilterValue, DashboardWidget, ID, PlanLimitDetails, Report, WidgetResult } from '@/api/types';
import { TITLE_MAX } from '@/features/reports/CreateReportDialog';
import { formatDate, formatNumber } from '@/lib/format';
import { dashboardError } from './dashboardErrors';

/** The contract: 1 to 30 charts per save, and at most 30 answers in a report. */
export const MAX_SAVED_CHARTS = 30;
export const MAX_REPORT_ANSWERS = 30;

export const SHARED_REPORT_LINE = 'Has an open share link. Turn it off, or save to a new report.';
export const SHARED_REPORT_MESSAGE = "That report has an open share link, so it can't be changed. Turn the link off, or save to a new report.";

/** A widget can be saved when its current result came back without an error. */
export const isWorking = (result: WidgetResult | undefined) => Boolean(result && !result.error);

/** The default title of a new report. */
export const defaultReportTitle = (datasetName: string) => `${datasetName}, dashboard`.slice(0, TITLE_MAX);

/** One applied filter in words, with the dashboard's own label: "Store is Durban, Sandton", "Sale date from 1 October 2026". */
export function describeFilter(value: DashboardFilterValue, filters: DashboardFilter[]): string | null {
  const filter = filters.find((f) => f.id === value.filter_id);
  const label = filter?.label ?? value.filter_id;
  if (value.values && value.values.length > 0) return `${label} is ${value.values.join(', ')}`;
  const from = value.from ? formatDate(value.from) : null;
  const to = value.to ? formatDate(value.to) : null;
  if (from && to) return `${label} from ${from} to ${to}`;
  if (from) return `${label} from ${from}`;
  if (to) return `${label} up to ${to}`;
  return null;
}

/** "Filtered to: Store is Durban; Sale date from … to …." or "No filters. All rows." */
export function filtersNote(applied: DashboardFilterValue[], filters: DashboardFilter[]): string {
  const parts = applied.map((v) => describeFilter(v, filters)).filter((p): p is string => p !== null);
  return parts.length > 0 ? `Filtered to: ${parts.join('; ')}.` : 'No filters. All rows.';
}

export const chartCount = (n: number) => `${formatNumber(n, 0)} ${n === 1 ? 'chart' : 'charts'}`;

/** Why "Save to report" cannot be pressed yet, or null when it can. */
export function submitBlocker({
  selected,
  target,
  title,
  report,
}: {
  selected: number;
  target: 'new' | 'existing';
  title: string;
  report: Report | null;
}): string | null {
  if (selected === 0) return 'Pick at least one chart.';
  if (selected > MAX_SAVED_CHARTS) return `Pick ${formatNumber(MAX_SAVED_CHARTS, 0)} charts or fewer.`;
  if (target === 'new') {
    const trimmed = title.trim();
    if (!trimmed) return 'Give the report a title.';
    if (trimmed.length > TITLE_MAX) return `Keep the title to ${formatNumber(TITLE_MAX, 0)} characters or fewer.`;
  } else if (!report) {
    return 'Choose a report to add to.';
  }
  return null;
}

/** What a failed save means for the dialog. */
export type SaveFailure =
  | { kind: 'shared_report'; text: string }
  | { kind: 'widgets'; text: string; widgetIds: ID[] }
  | { kind: 'too_many_answers'; text: string }
  | { kind: 'plan_limit'; details: PlanLimitDetails }
  | { kind: 'other'; text: string; canRetry: boolean };

/**
 * Reads a failed save: which report or charts the server refused (by the 422 field paths of the contract), the plan
 * limit, or an ordinary error in the wording used elsewhere. `sent` is the request's widget ids, in order.
 */
export function readSaveFailure(
  error: unknown,
  { sent, widgets, report }: { sent: ID[]; widgets: DashboardWidget[]; report: Report | null },
): SaveFailure {
  if (isApiError(error)) {
    if (error.planLimit) return { kind: 'plan_limit', details: error.planLimit };
    const fields = error.fieldErrors;
    if ('report_id' in fields) return { kind: 'shared_report', text: SHARED_REPORT_MESSAGE };
    if ('widget_ids' in fields) {
      const room = report ? Math.max(0, MAX_REPORT_ANSWERS - report.block_count) : null;
      const numbers =
        report && room !== null
          ? ` It has ${formatNumber(report.block_count, 0)} of ${formatNumber(MAX_REPORT_ANSWERS, 0)} answers, so it has room for ${chartCount(room)}; you picked ${formatNumber(sent.length, 0)}.`
          : '';
      return { kind: 'too_many_answers', text: `That report can't hold this many more charts.${numbers}` };
    }
    const failed = Object.keys(fields)
      .map((path) => /^widget_ids\.(\d+)$/.exec(path))
      .map((m) => (m ? sent[Number(m[1])] : undefined))
      .filter((id): id is ID => Boolean(id));
    if (failed.length > 0) {
      const titles = failed.map((id) => `"${widgets.find((w) => w.id === id)?.title ?? 'A chart'}"`);
      const left = titles.length === 1 ? `${titles[0]} could not be run now, so it was left out.` : `${titles.join(', ')} could not be run now, so they were left out.`;
      return { kind: 'widgets', widgetIds: failed, text: `Nothing was saved. ${left} Save again to save the others.` };
    }
    // Network failures (status 0) and 429 can be tried again; the others say what to do instead.
    const { text } = dashboardError(error);
    return { kind: 'other', text, canRetry: error.status === 0 || error.status === 429 };
  }
  return { kind: 'other', text: dashboardError(error).text, canRetry: true };
}

/** The toast after a save. */
export function savedMessage({ title, count, created }: { title: string; count: number; created: boolean }): string {
  return created ? `Created report "${title}" and saved ${chartCount(count)} to it.` : `Saved ${chartCount(count)} to "${title}".`;
}
