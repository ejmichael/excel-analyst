import type { CellValue, ValueFormat } from '../../types/api.js';

/**
 * Narrative tokens (API_CONTRACT "Narrative tokens"): `{{rows}}` is the true row_count, `{{r<i>.<column>}}` the value in
 * result row i (0-based, first 50 rows) and result column <column>, formatted by chart.value_format with en-ZA Intl.
 * The numbers_from_data check fails on any unresolved token, more than 40 tokens, or any free-standing number of two or
 * more digits in the template other than a year 1990-2099.
 */

export const MAX_TOKENS = 40;
export const MAX_TOKEN_ROW = 49;
export const UNRESOLVED = '[?]';

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const ROW_TOKEN_RE = /^r(\d+)\.(.+)$/;

const zar = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' });
const integer = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * Shown for an empty (NULL) cell: it resolved, there is simply no value. A text cell (usually a group label, such as
 * the group of rows with no job title) reads "(blank)", as the client shows it; every other format reads "(no value)".
 */
export const EMPTY_VALUE = '(no value)';
export const EMPTY_TEXT = '(blank)';

/** Formats one cell, or returns null if the value cannot be shown in that format. */
export function formatValue(value: CellValue, format: ValueFormat): string | null {
  if (value === null) return format === 'text' ? EMPTY_TEXT : EMPTY_VALUE;
  if (format === 'text') return String(value);
  if (format === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
    if (!m) return null;
    return date.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
  }
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  switch (format) {
    case 'zar':
      return zar.format(n);
    case 'integer':
      return integer.format(n);
    case 'number':
      return number.format(n);
    case 'percent':
      // The SQL returns a fraction (0.123); shown times 100 with one decimal.
      return `${percent.format(n * 100)}%`;
  }
}

export interface RenderInput {
  template: string;
  rows: Array<Record<string, CellValue>>;
  rowCount: number;
  valueFormat: Record<string, ValueFormat>;
}

/**
 * Why a narrative failed the numbers_from_data rules, as fixed categories that are safe to log (no text or
 * values). Logged in usage_events meta when the narrator is asked to retry.
 */
export type NarrativeProblemCategory =
  | 'unknown_token'
  | 'missing_row'
  | 'unknown_column'
  | 'unformattable_value'
  | 'too_many_tokens'
  | 'free_standing_number';

export interface RenderResult {
  /** Rendered text; unresolved tokens are "[?]", free-standing numbers left in place. */
  text: string;
  ok: boolean;
  /** Plain-English problems, used in the narrator retry line and the check detail. */
  problems: string[];
  /** One category per problem, same order as `problems`. */
  categories: NarrativeProblemCategory[];
  tokenCount: number;
}

/**
 * Deterministic cleanup before rendering: a token for a rand amount already renders as "R 1 234,56", so a currency
 * symbol or word the model wrote next to it would double it ("RR 99 284,58", "R 30 413,80 rand"). For each token whose
 * column value_format is zar, this removes an immediately preceding standalone "R" or "ZAR" (any case, optional space)
 * and an immediately following "ZAR", "rand" or "rands" (any case, optional space). Other formats are left alone.
 */
// prefix: a standalone R or ZAR (no letter or digit before it) with an optional space; token; suffix: an optional space
// and ZAR, rand or rands that is a whole word (so "grand" or "random" never match).
const ZAR_NEIGHBOURS_RE =
  /((?<![\p{L}\p{N}])(?:R|ZAR) ?)?(\{\{\s*r\d+\.([^{}\s]+?)\s*\}\})( ?(?<![\p{L}\p{N}])(?:ZAR|rands?)(?![\p{L}\p{N}]))?/giu;

export function stripCurrencyAroundZarTokens(template: string, valueFormat: Record<string, ValueFormat>): string {
  return template.replace(
    ZAR_NEIGHBOURS_RE,
    (whole, prefix: string | undefined, token: string, column: string, suffix: string | undefined) => {
      if (valueFormat[column] !== 'zar' || (!prefix && !suffix)) return whole;
      return token;
    },
  );
}

/** Free-standing numbers of two or more digits outside tokens, except years 1990-2099. */
export function freeStandingNumbers(template: string): string[] {
  const outside = template.replace(TOKEN_RE, ' ');
  const found: string[] = [];
  for (const m of outside.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 2) continue;
    if (/^\d{4}$/.test(m[0]) && Number(m[0]) >= 1990 && Number(m[0]) <= 2099) continue;
    found.push(m[0]);
  }
  return found;
}

export function renderNarrative({ template: raw, rows, rowCount, valueFormat }: RenderInput): RenderResult {
  const template = stripCurrencyAroundZarTokens(raw, valueFormat);
  const problems: string[] = [];
  const categories: NarrativeProblemCategory[] = [];
  const problem = (category: NarrativeProblemCategory, text: string) => {
    categories.push(category);
    problems.push(text);
  };
  let tokenCount = 0;
  const text = template.replace(TOKEN_RE, (_whole, inner: string) => {
    tokenCount++;
    if (inner === 'rows') return integer.format(rowCount);
    const m = ROW_TOKEN_RE.exec(inner);
    if (!m) {
      problem('unknown_token', `unknown token {{${inner}}}`);
      return UNRESOLVED;
    }
    const index = Number(m[1]);
    const column = m[2]!;
    if (index > MAX_TOKEN_ROW || index >= rows.length) {
      problem('missing_row', `{{${inner}}} points to a row that does not exist`);
      return UNRESOLVED;
    }
    const format = valueFormat[column];
    const row = rows[index]!;
    if (!format || !(column in row)) {
      problem('unknown_column', `{{${inner}}} uses a column that is not in the result`);
      return UNRESOLVED;
    }
    const formatted = formatValue(row[column] ?? null, format);
    if (formatted === null) {
      problem('unformattable_value', `{{${inner}}} cannot be shown as ${format}`);
      return UNRESOLVED;
    }
    return formatted;
  });
  if (tokenCount > MAX_TOKENS) problem('too_many_tokens', `more than ${MAX_TOKENS} tokens`);
  for (const n of freeStandingNumbers(template)) problem('free_standing_number', `the number "${n}" is written directly instead of as a token`);
  return { text, ok: problems.length === 0, problems, categories, tokenCount };
}
