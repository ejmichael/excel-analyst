/**
 * Analyst OS: API types. SOURCE OF TRUTH for request/response shapes.
 * Copy verbatim to server/src/types/api.ts and client/src/api/types.ts.
 * JSON keys are snake_case and match DB columns. Success bodies are wrapped as ApiOk<T>.
 */

// ---------- primitives ----------
export type ID = string; // UUID
export type ISODate = string; // YYYY-MM-DD
export type ISODateTime = string; // ISO 8601 with offset

export interface ApiOk<T> {
  data: T;
}

export type ErrorCode =
  | 'unauthorized' // 401 missing/invalid token
  | 'forbidden' // 403
  | 'consent_required' // 403 terms/privacy not accepted yet
  | 'not_found' // 404 (also for rows owned by someone else)
  | 'validation_failed' // 422 details: field errors
  | 'cannot_answer' // 422 the question cannot be answered from this dataset
  | 'schema_mismatch' // 422 template run: details: SchemaMismatchDetails
  | 'file_unsupported' // 415
  | 'file_too_large' // 413
  | 'plan_limit' // 402 details: PlanLimitDetails
  | 'dataset_not_ready' // 409 still profiling, or failed
  | 'dataset_expired' // 410 source file removed by retention
  | 'conflict' // 409
  | 'rate_limited' // 429
  | 'llm_failed' // 502 model call failed or timed out; nothing was saved
  | 'internal'; // 500

export interface ApiError {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Returned by every DELETE that succeeds. */
export interface Deleted {
  deleted: true;
}

/** Returned by fire-and-forget POSTs such as feedback. */
export interface Ack {
  received: true;
}

// ---------- plans, usage, billing ----------
export type Plan = 'free' | 'solo' | 'practice' | 'practice_plus';

export interface PlanLimits {
  plan: Plan;
  price_zar: number;
  max_workspaces: number;
  max_datasets_per_month: number;
  max_questions_per_month: number;
  max_reports_per_month: number;
  max_rows: number;
  max_file_mb: number;
  max_templates: number;
  branding: boolean;
  share_links: boolean;
  white_label: boolean;
  retention_days: number;
}

export type LimitKey =
  | 'max_workspaces'
  | 'max_datasets_per_month'
  | 'max_questions_per_month'
  | 'max_reports_per_month'
  | 'max_rows'
  | 'max_file_mb'
  | 'max_templates'
  | 'branding'
  | 'share_links';

export interface PlanLimitDetails {
  limit_key: LimitKey;
  limit: number; // 0 for a feature flag that is off
  used: number;
  upgrade_to: Plan | null;
}

export interface Usage {
  month_start: ISODate; // first day of the current month, SAST
  uploads: number;
  questions: number;
  reports: number;
  report_runs: number;
  exports: number;
  workspaces: number;
  templates: number;
}

export type SubscriptionStatus = 'none' | 'active' | 'past_due' | 'cancelled';

export interface Subscription {
  plan: Plan;
  status: SubscriptionStatus;
  amount_zar: number | null;
  next_billing_date: ISODate | null;
  cancelled_at: ISODateTime | null;
}

export interface BillingPlan {
  plan: Plan;
  price_zar: number;
  limits: PlanLimits;
}

export interface CheckoutRequest {
  plan: Exclude<Plan, 'free'>;
}

/** The client builds a hidden form with these fields and POSTs it to action_url (PayFast hosted page). */
export interface CheckoutResponse {
  action_url: string;
  method: 'POST';
  fields: Record<string, string>;
}

// ---------- me ----------
export interface Brand {
  business_name: string | null;
  logo_url: string | null; // signed URL, expires in 1 hour; null if none
  color: string; // #RRGGBB
}

export interface Me {
  user_id: ID;
  email: string;
  full_name: string | null;
  business_name: string | null;
  plan: Plan;
  consent_accepted: boolean;
  brand: Brand;
  limits: PlanLimits;
  usage: Usage;
  subscription: Subscription | null;
}

export interface UpdateMeRequest {
  full_name?: string | null;
  business_name?: string | null;
  brand_color?: string; // #RRGGBB; requires limits.branding (otherwise 402 plan_limit)
  accept_terms?: true; // sets popia_consent_at = now (once)
}

export interface DeleteMeRequest {
  confirm: 'DELETE';
}

// ---------- workspaces ----------
export interface Workspace {
  id: ID;
  name: string;
  is_default: boolean;
  created_at: ISODateTime;
}

export interface CreateWorkspaceRequest {
  name: string;
}

export interface UpdateWorkspaceRequest {
  name: string;
}

// ---------- datasets ----------
export type DatasetStatus = 'uploading' | 'profiling' | 'ready' | 'failed' | 'expired';
export type FileType = 'csv' | 'xlsx';
export type ColumnDataType = 'text' | 'integer' | 'decimal' | 'date' | 'datetime' | 'boolean';
export type ColumnSemantic =
  | 'none'
  | 'currency_zar'
  | 'percentage'
  | 'identifier'
  | 'category'
  | 'email'
  | 'phone'
  | 'sa_id_number'
  | 'person_name'
  | 'address'
  | 'free_text';

export interface ParseOptions {
  sheet_name?: string | null; // XLSX
  header_row?: number | null; // 1-based row number in the file
  delimiter?: ',' | ';' | '\t' | '|' | null; // CSV
  decimal_separator?: '.' | ',' | null;
  date_format?: 'dmy' | 'mdy' | 'ymd' | null;
}

export interface DatasetColumn {
  id: ID;
  position: number;
  name: string;
  display_name: string | null;
  sql_name: string;
  data_type: ColumnDataType;
  semantic: ColumnSemantic;
  is_pii: boolean;
  vat_included: boolean | null; // null = unknown
  null_count: number;
  distinct_count: number;
  min_value: string | null;
  max_value: string | null;
  sample_values: string[]; // masked if is_pii
}

export interface SuggestedQuestion {
  question: string;
  why: string;
}

export interface Dataset {
  id: ID;
  workspace_id: ID;
  name: string;
  original_filename: string;
  file_type: FileType;
  size_bytes: number;
  row_count: number | null;
  status: DatasetStatus;
  error_message: string | null;
  warnings: string[];
  expires_at: ISODateTime | null;
  created_at: ISODateTime;
}

export interface DatasetDetail extends Dataset {
  columns: DatasetColumn[];
  parse_options: ParseOptions; // effective options used (detected or overridden)
  sheet_names: string[];
  preamble_lines: string[]; // text found above the header row
  excluded_rows: number;
  suggestions: SuggestedQuestion[];
}

/** POST /datasets is multipart/form-data: file (required), workspace_id (required), name (optional). */

export interface UpdateDatasetRequest {
  name?: string;
  columns?: Array<{
    id: ID;
    display_name?: string | null;
    semantic?: ColumnSemantic;
    is_pii?: boolean;
    vat_included?: boolean | null;
  }>;
}

export type ReparseRequest = ParseOptions;

export interface DatasetPreview {
  columns: Array<{ sql_name: string; label: string; data_type: ColumnDataType }>;
  rows: Array<Record<string, string | number | boolean | null>>;
  total_rows: number;
}

// ---------- questions and blocks ----------
export type ChartType = 'table' | 'bar' | 'line' | 'area' | 'pie' | 'kpi';
export type ValueFormat = 'zar' | 'number' | 'integer' | 'percent' | 'date' | 'text';
export type CellValue = string | number | boolean | null;

export interface ChartSpec {
  type: ChartType;
  x: string | null; // result column for the category/time axis (null for kpi)
  y: string[]; // result columns plotted as values
  series: string | null; // result column that splits series, or null
  orientation: 'vertical' | 'horizontal';
  stacked: boolean;
  value_format: Record<string, ValueFormat>; // by result column name
}

export interface ResultColumn {
  name: string;
  format: ValueFormat;
}

export type CheckType = 'sql_read_only' | 'numbers_from_data' | 'total_reconciles' | 'result_not_truncated';

export interface BlockCheck {
  type: CheckType;
  ok: boolean;
  label: string; // human-readable, e.g. "Total of Net Amount matches your file"
  detail?: string;
  expected?: number;
  actual?: number;
}

export type BlockStatus = 'ok' | 'flagged';
export type BlockSource = 'user' | 'suggested' | 'template';

export interface Block {
  id: ID;
  dataset_id: ID | null;
  question: string;
  title: string;
  sql: string;
  columns: ResultColumn[];
  rows: Array<Record<string, CellValue>>; // at most 500
  row_count: number; // true count
  truncated: boolean;
  chart: ChartSpec;
  narrative: string; // rendered; numbers came from the rows
  follow_ups: string[];
  checks: BlockCheck[];
  status: BlockStatus; // 'flagged' if any check failed
  source: BlockSource;
  has_source_rows: boolean; // true if source_filter_sql exists and the dataset still exists
  created_at: ISODateTime;
}

export interface AskRequest {
  question: string; // 3 to 500 characters
  chart_hint?: ChartType;
  source?: 'user' | 'suggested';
}

export interface BlockFeedbackRequest {
  kind: 'looks_wrong';
  note?: string; // up to 500 characters; stored in usage_events.meta, never sent to the model
}

export interface SourceRows {
  columns: Array<{ sql_name: string; label: string }>;
  rows: Array<Record<string, CellValue>>;
  total: number;
  limit: number;
  offset: number;
}

// ---------- reports ----------
export interface Report {
  id: ID;
  workspace_id: ID;
  title: string;
  subtitle: string | null;
  period_label: string | null;
  notes: string | null;
  template_id: ID | null;
  block_count: number;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface ReportBlock {
  position: number;
  heading_override: string | null;
  block: Block;
}

export interface ComparisonMetric {
  key: string;
  label: string;
  format: ValueFormat;
  current: number;
  previous: number;
  change_abs: number;
  change_pct: number | null; // null if previous is 0
}

export interface ReportComparison {
  previous_run_id: ID;
  previous_period_label: string | null;
  metrics: ComparisonMetric[];
}

export interface ReportDetail extends Report {
  brand: Brand;
  watermark: boolean; // true on the free plan
  blocks: ReportBlock[];
  comparison: ReportComparison | null;
}

export interface CreateReportRequest {
  workspace_id: ID;
  title: string;
  subtitle?: string | null;
  period_label?: string | null;
  block_ids: ID[]; // in display order, 1 to 30
}

export interface UpdateReportRequest {
  title?: string;
  subtitle?: string | null;
  period_label?: string | null;
  notes?: string | null;
  blocks?: Array<{ block_id: ID; heading_override?: string | null }>; // replaces the list and order
}

// ---------- sharing ----------
export interface ShareLink {
  id: ID;
  report_id: ID;
  token: string;
  url: string; // CLIENT_URL + /r/ + token
  show_working: boolean;
  expires_at: ISODateTime | null;
  revoked_at: ISODateTime | null;
  view_count: number;
  created_at: ISODateTime;
}

export interface CreateShareLinkRequest {
  expires_in_days?: 7 | 30 | 90 | null; // null or omitted = no expiry
  show_working?: boolean; // default false: hides SQL and checks on the public page
}

/** Public report: same as ReportDetail, but blocks' `sql` is '' and `checks` is [] unless show_working is true. */
export type PublicReport = ReportDetail;

// ---------- templates and runs ----------
export interface TemplateColumn {
  sql_name: string;
  name: string;
  data_type: ColumnDataType;
}

export interface TemplateBlockDef {
  title: string;
  question: string;
  sql: string;
  chart: ChartSpec;
  reconcile: { column: string; aggregation: 'sum' | 'count'; total_sql: string } | null;
  narrative_instructions: string;
}

export interface TemplateMetricDef {
  key: string;
  label: string;
  format: ValueFormat;
  block_index: number; // index into definition
  column: string; // result column
  row_index: number; // usually 0
}

export interface ReportTemplate {
  id: ID;
  workspace_id: ID;
  name: string;
  expected_columns: TemplateColumn[];
  block_count: number;
  metrics: TemplateMetricDef[];
  created_at: ISODateTime;
}

export interface SaveTemplateRequest {
  name: string;
  metrics?: Array<{ block_id: ID; column: string; label: string; row_index?: number }>;
  // If omitted, the server picks the first numeric column of every single-row block.
}

export interface RunTemplateRequest {
  dataset_id: ID;
  period_label?: string | null;
}

export interface ReportRun {
  id: ID;
  template_id: ID;
  dataset_id: ID | null;
  report_id: ID | null;
  period_label: string | null;
  status: 'running' | 'done' | 'failed';
  error: string | null;
  created_at: ISODateTime;
  finished_at: ISODateTime | null;
}

export interface SchemaMismatchDetails {
  missing: string[]; // expected sql_names not found in the new dataset
  type_changes: Array<{ column: string; expected: ColumnDataType; found: ColumnDataType }>;
}
