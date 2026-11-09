import type { ColumnDataType, ColumnSemantic, DatasetStatus, ParseOptions } from '@/api/types';

export const SEMANTIC_OPTIONS: Array<{ value: ColumnSemantic; label: string; help: string }> = [
  { value: 'none', label: 'Plain value', help: 'No special meaning.' },
  { value: 'currency_zar', label: 'Money (rand)', help: 'Amounts in rand that can be added up.' },
  { value: 'percentage', label: 'Percentage', help: 'A share or rate, stored as a fraction.' },
  { value: 'identifier', label: 'Reference or ID', help: 'Codes like order or invoice numbers. Never added up.' },
  { value: 'category', label: 'Category', help: 'Groups such as store, product or province.' },
  { value: 'email', label: 'Email address', help: 'Personal information.' },
  { value: 'phone', label: 'Phone number', help: 'Personal information.' },
  { value: 'sa_id_number', label: 'SA ID number', help: 'Personal information.' },
  { value: 'person_name', label: 'Person’s name', help: 'Personal information.' },
  { value: 'address', label: 'Address', help: 'Personal information.' },
  { value: 'free_text', label: 'Free text', help: 'Notes or descriptions typed by people.' },
];

export const PII_SEMANTICS = new Set<ColumnSemantic>(['email', 'phone', 'sa_id_number', 'person_name', 'address']);

export function semanticHelp(value: ColumnSemantic): string {
  return SEMANTIC_OPTIONS.find((o) => o.value === value)?.help ?? '';
}

export const DATA_TYPE_LABELS: Record<ColumnDataType, string> = {
  text: 'Text',
  integer: 'Whole number',
  decimal: 'Number',
  date: 'Date',
  datetime: 'Date and time',
  boolean: 'Yes or no',
};

export const STATUS_LABELS: Record<DatasetStatus, string> = {
  uploading: 'Uploading',
  profiling: 'Reading file',
  ready: 'Ready',
  failed: 'Could not read',
  expired: 'Expired',
};

export const DELIMITER_LABELS: Record<NonNullable<ParseOptions['delimiter']>, string> = {
  ',': 'Comma (,)',
  ';': 'Semicolon (;)',
  '\t': 'Tab',
  '|': 'Pipe (|)',
};

export const DECIMAL_LABELS: Record<NonNullable<ParseOptions['decimal_separator']>, string> = {
  '.': 'Full stop (1234.50)',
  ',': 'Comma (1234,50)',
};

export const DATE_ORDER_LABELS: Record<NonNullable<ParseOptions['date_format']>, string> = {
  dmy: 'Day first, 31/10/2026',
  mdy: 'Month first, 10/31/2026',
  ymd: 'Year first, 2026-10-31',
};

/** The parse options in one or two plain sentences. */
export function describeParseOptions(options: ParseOptions, fileType: 'csv' | 'xlsx'): string[] {
  const lines: string[] = [];
  if (fileType === 'xlsx') {
    lines.push(options.sheet_name ? `We read the sheet “${options.sheet_name}”.` : 'We read the first sheet.');
  } else if (options.delimiter) {
    lines.push(`Columns are separated by ${DELIMITER_LABELS[options.delimiter].replace(/ \(.*\)$/, '').toLowerCase()}s.`);
  }
  if (options.header_row) lines.push(`The column names are on row ${options.header_row}.`);
  if (options.decimal_separator) {
    lines.push(`Numbers use a ${options.decimal_separator === ',' ? 'comma' : 'full stop'} before the decimals.`);
  }
  if (options.date_format) lines.push(`Dates are read ${DATE_ORDER_LABELS[options.date_format].toLowerCase()}.`);
  return lines;
}
