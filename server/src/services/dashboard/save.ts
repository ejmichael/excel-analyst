import { z } from 'zod';
import { AppError, notFound, throwIfDbError } from '../../lib/errors.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import type { BlockCheck, CellValue, ChartSpec, DashboardWidget, ResultColumn, ValidationFailedDetails } from '../../types/api.js';
import { MAX_REPORT_BLOCKS, OTHER_WORKSPACE_MESSAGE, REPORT_LIMITS } from '../reports.js';
import { SandboxError, type SandboxSession } from '../sandbox/sandbox.js';
import { dashboardDataBody, type ResolvedFilter, scopedSql, scopePredicate, WIDGET_ROW_CAP } from './data.js';
import { widgetOutput } from './widgets.js';

/**
 * POST /datasets/:id/dashboard/save-to-report (Part W3). No model is called. Each widget's stored SQL runs now under the
 * filters, exactly as for POST .../dashboard/data, and becomes a block with source 'dashboard', the filters in force and
 * a fixed caption written here. Blocks and the report are written by one SQL function (one transaction). Never logs
 * titles, filter values, SQL or results.
 */

const COUNT = `Choose 1 to ${MAX_REPORT_BLOCKS} widgets.`;

export const saveToReportBody = z
  .strictObject({
    filters: dashboardDataBody.shape.filters,
    widget_ids: z
      .array(z.uuid())
      .min(1, COUNT)
      .max(MAX_REPORT_BLOCKS, COUNT)
      .refine((ids) => new Set(ids).size === ids.length, 'Each widget can be saved only once.'),
    report_id: z.uuid().optional(),
    title: z.string().trim().min(1, 'Give the report a title.').max(REPORT_LIMITS.title, `At most ${REPORT_LIMITS.title} characters.`).optional(),
  })
  .refine((b) => b.report_id === undefined || b.title === undefined, { message: 'A title is only used for a new report.', path: ['title'] });
export type SaveToReportBody = z.infer<typeof saveToReportBody>;

const invalid = (message: string, fields: ValidationFailedDetails['fields']) => new AppError('validation_failed', message, { fields } satisfies ValidationFailedDetails);

/** The requested widgets in request order; an id that is not one of the dashboard's widgets is a 422. */
export function pickWidgets(widgets: DashboardWidget[], ids: string[]): DashboardWidget[] {
  const byId = new Map(widgets.map((w) => [w.id, w]));
  const fields = ids.flatMap((id, i) => (byId.has(id) ? [] : [{ location: 'body' as const, path: `widget_ids.${i}`, message: 'This widget is not part of this dashboard.' }]));
  if (fields.length > 0) throw invalid('Some widgets are not part of this dashboard.', fields);
  return ids.map((id) => byId.get(id)!);
}

/** Default title of a new report: "<dataset name>, dashboard", cut to the report title limit. */
export function defaultReportTitle(datasetName: string): string {
  const suffix = ', dashboard';
  return `${datasetName.slice(0, REPORT_LIMITS.title - suffix.length).trimEnd()}${suffix}`;
}

/**
 * The block's text: fixed words around the dataset name and the filters in force (the file's own labels and values,
 * as plain text). No model, and no figure the server worked out.
 */
export function dashboardCaption(datasetName: string, filters: ResolvedFilter[]): string {
  if (filters.length === 0) return `From "${datasetName}". No filters.`;
  const parts = filters.map((f) => {
    if (f.kind === 'category') return `${f.label} is ${f.values.join(', ')}`;
    if (f.from && f.to) return `Dates from ${f.from} to ${f.to}`;
    return f.from ? `Dates from ${f.from}` : `Dates up to ${f.to}`;
  });
  return `From "${datasetName}". Filtered to: ${parts.join('; ')}.`;
}

/** One block as passed to save_dashboard_blocks (db/migrations/20261124_01_dashboard_save.sql). */
export interface DashboardBlockDraft {
  title: string;
  sql: string;
  columns: ResultColumn[];
  rows: Array<Record<string, CellValue>>;
  row_count: number;
  truncated: boolean;
  chart: ChartSpec;
  narrative: string;
  checks: BlockCheck[];
  status: 'ok' | 'flagged';
  filters: ResolvedFilter[];
}

const WIDGET_TIMEOUT = 'This widget took longer than 10 seconds and was stopped.';
const WIDGET_FAILED = 'This widget could not be calculated.';

/**
 * Runs every requested widget under the filters (one sandbox, each query with its own 10 s limit and the dashboard's
 * row cap). Any failure is a 422 naming the failed widgets, and nothing is saved.
 */
export async function runWidgetsForSave(
  session: SandboxSession,
  widgets: DashboardWidget[],
  filters: ResolvedFilter[],
  caption: string,
): Promise<DashboardBlockDraft[]> {
  const { where, params } = scopePredicate(filters);
  const drafts: DashboardBlockDraft[] = [];
  const fields: ValidationFailedDetails['fields'] = [];
  for (const [i, w] of widgets.entries()) {
    try {
      const result = await session.query(scopedSql(w.sql, where), { maxRows: WIDGET_ROW_CAP, params: where ? params : [] });
      const out = widgetOutput(w, result, WIDGET_ROW_CAP);
      drafts.push({
        title: w.title,
        sql: w.sql,
        columns: out.columns,
        rows: result.rows.slice(0, WIDGET_ROW_CAP),
        row_count: result.rowCount,
        truncated: out.truncated,
        chart: w.chart,
        narrative: caption,
        checks: out.checks,
        status: out.checks.every((c) => c.ok) ? 'ok' : 'flagged',
        filters,
      });
    } catch (err) {
      if (!(err instanceof SandboxError)) throw err;
      fields.push({ location: 'body', path: `widget_ids.${i}`, message: `Widget ${w.id}: ${err.kind === 'timeout' ? WIDGET_TIMEOUT : WIDGET_FAILED}` });
    }
  }
  if (fields.length > 0) throw invalid('Some widgets could not be calculated, so nothing was saved.', fields);
  return drafts;
}

export const REPORT_FULL_MESSAGE = `A report holds at most ${MAX_REPORT_BLOCKS} answers. Choose fewer widgets or another report.`;
export const reportFull = () => invalid(REPORT_FULL_MESSAGE, [{ location: 'body', path: 'widget_ids', message: REPORT_FULL_MESSAGE }]);
export const SHARED_REPORT_MESSAGE =
  'This report has a working share link, so adding to it would publish new data on that link. Revoke the link first, or save to a new report.';
export const sharedReport = () => invalid(SHARED_REPORT_MESSAGE, [{ location: 'body', path: 'report_id', message: SHARED_REPORT_MESSAGE }]);
export const otherWorkspace = () => invalid(OTHER_WORKSPACE_MESSAGE, [{ location: 'body', path: 'report_id', message: OTHER_WORKSPACE_MESSAGE }]);

/** Writes the blocks and the new or appended report in one transaction. Returns the report id. */
export async function saveDashboardBlocks(
  userId: string,
  datasetId: string,
  reportId: string | null,
  title: string | null,
  blocks: DashboardBlockDraft[],
): Promise<string> {
  const { data, error } = await supabaseAdmin().rpc('save_dashboard_blocks', {
    p_owner_id: userId,
    p_dataset_id: datasetId,
    p_report_id: reportId,
    p_title: title,
    p_blocks: blocks,
  });
  if (error?.code === 'P0002') throw notFound(reportId ? 'Report not found.' : 'File not found.');
  if (error?.code === '22023' && /report_full/.test(error.message ?? '')) throw reportFull();
  if (error?.code === '22023' && /report_other_workspace/.test(error.message ?? '')) throw otherWorkspace();
  throwIfDbError('dashboards: save to report', error);
  return data as string;
}
