import type { CellValue, ChartType, ColumnDataType, ColumnSemantic, ValueFormat } from '../../types/api.js';
import { isEmail, isSaIdNumber, isSaMobile, maskValue, placeholderFor, semanticFromName } from '../parsing/pii.js';

/**
 * The user messages for the planner and narrator (LLM_PROMPTS sections 2 and 3). The model sees only what
 * ARCHITECTURE 5 allows: schema lines, at most 5 masked sample rows (planner), at most 50 masked result rows
 * (narrator). Every cell is cut to 80 characters and kept on one line inside <data> tags. The same masking
 * function as Part 2 (maskValue / placeholderFor) is used everywhere.
 */

export const MAX_CELL = 80;
export const MAX_SAMPLE_ROWS = 5;
export const MAX_NARRATOR_ROWS = 50;
export const MAX_PROMPT_COLUMNS = 200;

export interface PromptColumn {
  name: string;
  display_name: string | null;
  sql_name: string;
  data_type: ColumnDataType;
  semantic: ColumnSemantic;
  is_pii: boolean;
  vat_included: boolean | null;
  min_value: string | null;
  max_value: string | null;
}

/** One line, at most 80 characters, unable to open or close a <data> block or break the table. */
export function promptCell(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  const flat = String(value)
    .replace(/<\/?data>/gi, '')
    .replace(/[\r\n\t|]+/g, ' ')
    .trim();
  return flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 1)}…` : flat;
}

const label = (c: PromptColumn) => c.display_name ?? c.name;

export function buildPlannerUser(input: {
  question: string;
  chartHint?: ChartType;
  datasetName: string;
  rowCount: number;
  columns: PromptColumn[];
  sampleRows: Array<Record<string, string>>;
}): string {
  const columns = input.columns.slice(0, MAX_PROMPT_COLUMNS);
  const lines = columns.map((c) => {
    const range = !c.is_pii && c.min_value !== null && c.max_value !== null ? `${promptCell(c.min_value)}..${promptCell(c.max_value)}` : '';
    const vat = c.vat_included === null ? 'unknown' : String(c.vat_included);
    return `${c.sql_name} | ${promptCell(label(c))} | ${c.data_type} | ${c.semantic} | ${c.is_pii ? 'pii' : 'no'} | ${vat} | ${range}`;
  });
  const table = [columns.map((c) => c.sql_name).join(' | ')];
  for (const row of input.sampleRows.slice(0, MAX_SAMPLE_ROWS)) {
    table.push(columns.map((c) => promptCell(maskValue(row[c.sql_name] ?? '', c))).join(' | '));
  }
  return [
    `Question: ${input.question}`,
    `Chart hint: ${input.chartHint ?? 'none'}`,
    `Dataset: ${promptCell(input.datasetName)} (${input.rowCount} rows)`,
    'Columns (sql_name | label | type | meaning | pii | vat_included | min..max):',
    ...lines,
    '<data>',
    ...table,
    '</data>',
  ].join('\n');
}

/**
 * Which result columns must be masked for the narrator: a result column whose name is a PII column's sql_name,
 * whose name itself looks personal, or whose values (any of the rows given) match the email, SA mobile or SA ID detectors.
 * Returns the placeholder to use for each masked column.
 */
export function resultMasks(
  resultColumns: string[],
  rows: Array<Record<string, CellValue>>,
  datasetColumns: PromptColumn[],
): Map<string, string> {
  const pii = new Map(datasetColumns.filter((c) => c.is_pii).map((c) => [c.sql_name, c]));
  const masks = new Map<string, string>();
  for (const name of resultColumns) {
    const source = pii.get(name);
    if (source) {
      masks.set(name, placeholderFor(source.semantic, source.name));
      continue;
    }
    const byName = semanticFromName(name);
    if (byName) {
      masks.set(name, placeholderFor(byName, name));
      continue;
    }
    for (const row of rows) {
      const v = row[name];
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      const s = String(v);
      if (isEmail(s)) masks.set(name, '[email]');
      else if (isSaIdNumber(s)) masks.set(name, '[id]');
      else if (isSaMobile(s)) masks.set(name, '[phone]');
      if (masks.has(name)) break;
    }
  }
  return masks;
}

export function buildNarratorUser(input: {
  question: string;
  title: string;
  instructions: string;
  columns: Array<{ name: string; format: ValueFormat }>;
  rows: Array<Record<string, CellValue>>;
  rowCount: number;
  truncated: boolean;
  datasetColumns: PromptColumn[];
}): string {
  const rows = input.rows.slice(0, MAX_NARRATOR_ROWS);
  const names = input.columns.map((c) => c.name);
  const masks = resultMasks(names, rows, input.datasetColumns);
  const table = [['row', ...names].join(' | ')];
  rows.forEach((row, i) => {
    const cells = names.map((n) => {
      const v = row[n];
      if (v === null || v === undefined || v === '') return '';
      return masks.get(n) ?? promptCell(v);
    });
    table.push([`r${i}`, ...cells].join(' | '));
  });
  const followUpColumns = input.datasetColumns.filter((c) => !c.is_pii).map((c) => promptCell(label(c)));
  return [
    `Question: ${input.question}`,
    `Title: ${input.title}`,
    `Writer instructions: ${input.instructions}`,
    `Result columns (name | format): ${input.columns.map((c) => `${c.name} | ${c.format}`).join('; ')}`,
    `Total rows: ${input.rowCount}   Truncated: ${input.truncated}`,
    '<data>',
    ...table,
    '</data>',
    `Dataset columns available for follow-ups: ${followUpColumns.join(', ')}`,
  ].join('\n');
}
