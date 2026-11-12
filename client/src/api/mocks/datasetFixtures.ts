import type {
  ColumnDataType,
  ColumnSemantic,
  DatasetColumn,
  DatasetDetail,
  FileType,
  ParseOptions,
  SuggestedQuestion,
} from '../types';

/**
 * Mock profiles shaped after fixtures/expected.json (column names, row counts, PII columns, preamble and
 * excluded rows). Sample values are taken from the fixture files; the stats are plausible, not computed.
 */

type ColumnSpec = {
  name: string;
  type: ColumnDataType;
  semantic?: ColumnSemantic;
  pii?: boolean;
  distinct: number;
  nulls?: number;
  min?: string | null;
  max?: string | null;
  samples: string[];
};

export interface DatasetTemplate {
  key: string;
  file_type: FileType;
  original_filename: string;
  name: string;
  size_bytes: number;
  row_count: number;
  columns: ColumnSpec[];
  parse_options: ParseOptions;
  sheet_names: string[];
  preamble_lines: string[];
  excluded_rows: number;
  warnings: string[];
  suggestions: SuggestedQuestion[];
  /** Raw day/month dates for the date column, so a date-order reparse can recompute it (fixture 04). */
  raw_dates?: { column: string; values: string[] };
}

/** Like the server: Private columns come back with placeholder samples and no min or max. */
const PLACEHOLDERS: Partial<Record<ColumnSemantic, string>> = {
  email: '[email]',
  phone: '[phone]',
  sa_id_number: '[id]',
  person_name: '[name]',
  address: '[address]',
};

export function maskColumn(column: DatasetColumn, raw: { samples: string[]; min: string | null; max: string | null }): void {
  if (column.is_pii) {
    const placeholder = PLACEHOLDERS[column.semantic] ?? '[hidden]';
    column.sample_values = raw.samples.map(() => placeholder);
    column.min_value = null;
    column.max_value = null;
  } else {
    column.sample_values = [...raw.samples];
    column.min_value = raw.min;
    column.max_value = raw.max;
  }
}

/** The unmasked samples for a template column, so turning Private off can show them again. */
export function rawSamplesFor(template: DatasetTemplate | undefined, name: string) {
  const spec = template?.columns.find((c) => c.name === name);
  return spec ? { samples: spec.samples, min: spec.min ?? null, max: spec.max ?? null } : null;
}

export function snakeCase(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'column'
  );
}

export function buildColumns(specs: ColumnSpec[]): DatasetColumn[] {
  return specs.map((spec, position) => {
    const column: DatasetColumn = {
    id: crypto.randomUUID(),
    position,
    name: spec.name,
    display_name: null,
    sql_name: snakeCase(spec.name),
    data_type: spec.type,
    semantic: spec.semantic ?? 'none',
    is_pii: spec.pii ?? false,
    vat_included: null,
    null_count: spec.nulls ?? 0,
    distinct_count: spec.distinct,
    min_value: spec.min ?? null,
    max_value: spec.max ?? null,
    sample_values: [],
    };
    maskColumn(column, { samples: spec.samples, min: spec.min ?? null, max: spec.max ?? null });
    return column;
  });
}

export const CARD_SALES: DatasetTemplate = {
  key: '01',
  file_type: 'csv',
  original_filename: '01_card_sales_semicolon_win1252.csv',
  name: 'Card sales October',
  size_bytes: 21_840,
  row_count: 240,
  columns: [
    { name: 'Transaction Date', type: 'date', distinct: 31, min: '2026-10-01', max: '2026-10-31', samples: ['2026-10-01', '2026-10-01', '2026-10-31'] },
    { name: 'Time', type: 'text', distinct: 214, samples: ['07:19', '08:00', '18:13'] },
    { name: 'Terminal', type: 'text', semantic: 'category', distinct: 3, samples: ['T02', 'T03', 'T03'] },
    { name: 'Store', type: 'text', semantic: 'category', distinct: 3, samples: ['Pietermaritzburg Padstal', 'Müller Bakkery Pretoria', 'Café Rosé Sandton'] },
    { name: 'Card Type', type: 'text', semantic: 'category', distinct: 2, samples: ['DEBIT', 'CREDIT', 'DEBIT'] },
    { name: 'Reference', type: 'text', semantic: 'identifier', distinct: 240, samples: ['TX88238046', 'TX10774160', 'TX95044719'] },
    { name: 'Gross Amount', type: 'decimal', semantic: 'currency_zar', distinct: 238, min: '-1205.40', max: '2498.12', samples: ['2425.44', '1694.55', '489.36'] },
    { name: 'Fee', type: 'decimal', semantic: 'currency_zar', distinct: 220, min: '0.00', max: '68.70', samples: ['66.70', '46.60', '13.46'] },
    { name: 'Net Amount', type: 'decimal', semantic: 'currency_zar', distinct: 238, min: '-1205.40', max: '2429.42', samples: ['2358.74', '1647.95', '475.90'] },
  ],
  parse_options: { sheet_name: null, header_row: 5, delimiter: ';', decimal_separator: ',', date_format: 'dmy' },
  sheet_names: [],
  preamble_lines: ['Sales report (synthetic test data)', 'Period: 01/10/2026 to 31/10/2026', 'Generated: 01/11/2026 06:00', ''],
  excluded_rows: 1,
  warnings: [],
  suggestions: [
    { question: 'Which store had the highest net sales in October?', why: 'Compares your stores on what actually reached your account.' },
    { question: 'How much did card fees cost in total?', why: 'Fees are easy to miss when you only look at gross sales.' },
    { question: 'What were net sales for each day of the month?', why: 'Shows quiet and busy days at a glance.' },
    { question: 'How many refunds were there, and what did they add up to?', why: 'Refunds appear as negative amounts in this file.' },
    { question: 'Which card type brings in the most sales?', why: 'Splits sales between debit and credit cards.' },
  ],
};

export const WEBSTORE: DatasetTemplate = {
  key: '02',
  file_type: 'csv',
  original_filename: '02_webstore_orders_utf8bom.csv',
  name: 'Webstore orders October',
  size_bytes: 24_310,
  row_count: 180,
  columns: [
    { name: 'Order ID', type: 'text', semantic: 'identifier', distinct: 180, samples: ['#1001', '#1002', '#1003'] },
    { name: 'Created at', type: 'datetime', distinct: 180, min: '2026-10-01T07:29:13', max: '2026-10-31T21:02:44', samples: ['2026-10-01T07:29:13', '2026-10-01T08:19:33', '2026-10-01T14:08:52'] },
    { name: 'Customer name', type: 'text', semantic: 'person_name', pii: true, distinct: 162, samples: ['Naledi Proef', 'Willem Test', 'Kobus Proef'] },
    { name: 'Customer email', type: 'text', semantic: 'email', pii: true, distinct: 180, samples: ['naledi.proef18@example.com', 'willem.test38@example.com', 'kobus.proef59@example.com'] },
    { name: 'Phone', type: 'text', semantic: 'phone', pii: true, distinct: 179, samples: ['082 555 8076', '082 555 2771', '082 555 2508'] },
    { name: 'Product', type: 'text', semantic: 'category', distinct: 8, samples: ['Biltong 250g', 'Candle, soy', 'Hot sauce 150ml'] },
    { name: 'Quantity', type: 'integer', distinct: 4, min: '1', max: '4', samples: ['3', '3', '1'] },
    { name: 'Unit price', type: 'decimal', semantic: 'currency_zar', distinct: 8, min: '45.00', max: '149.00', samples: ['95.00', '149.00', '45.00'] },
    { name: 'Discount', type: 'decimal', semantic: 'currency_zar', distinct: 12, min: '0.00', max: '59.60', samples: ['0.00', '0.00', '9.00'] },
    { name: 'Total', type: 'decimal', semantic: 'currency_zar', distinct: 64, min: '45.00', max: '596.00', samples: ['285.00', '447.00', '45.00'] },
    { name: 'Payment status', type: 'text', semantic: 'category', distinct: 3, samples: ['paid', 'refunded', 'pending'] },
    { name: 'Province', type: 'text', semantic: 'category', distinct: 9, samples: ['Mpumalanga', 'Limpopo', 'Eastern Cape'] },
  ],
  parse_options: { sheet_name: null, header_row: 1, delimiter: ',', decimal_separator: '.', date_format: 'ymd' },
  sheet_names: [],
  preamble_lines: [],
  excluded_rows: 0,
  warnings: [],
  suggestions: [
    { question: 'What were paid sales by province?', why: 'Only paid orders count as income.' },
    { question: 'Which products sell the most units?', why: 'Helps with stock planning.' },
    { question: 'How much was refunded in October?', why: 'Refunded orders are marked in the payment status.' },
    { question: 'What is the average value of a paid order?', why: 'A simple measure to track month to month.' },
    { question: 'How many orders are still pending?', why: 'Pending orders may still need follow-up.' },
  ],
};

export const BANK: DatasetTemplate = {
  key: '03',
  file_type: 'csv',
  original_filename: '03_bank_statement_comma_quoted.csv',
  name: 'Bank statement October',
  size_bytes: 8_120,
  row_count: 150,
  columns: [
    { name: 'Date', type: 'date', distinct: 31, min: '2026-10-01', max: '2026-10-31', samples: ['2026-10-01', '2026-10-01', '2026-10-31'] },
    { name: 'Description', type: 'text', semantic: 'category', distinct: 11, samples: ['EFT CREDIT CLIENT B', 'CARD SETTLEMENT', 'POS PURCHASE FUEL'] },
    { name: 'Amount', type: 'decimal', semantic: 'currency_zar', distinct: 150, min: '-7662.48', max: '12622.71', samples: ['6613.75', '12622.71', '-3398.31'] },
    { name: 'Balance', type: 'decimal', semantic: 'currency_zar', distinct: 150, min: '41210.06', max: '106665.88', samples: ['51824.25', '64446.96', '61048.65'] },
  ],
  parse_options: { sheet_name: null, header_row: 3, delimiter: ',', decimal_separator: '.', date_format: 'dmy' },
  sheet_names: [],
  preamble_lines: ['Account statement (synthetic test data)', 'Statement period 01/10/2026 - 31/10/2026'],
  excluded_rows: 1,
  warnings: [],
  suggestions: [
    { question: 'How much came in and how much went out in October?', why: 'Credits are positive and debits negative in this statement.' },
    { question: 'What are my biggest expenses?', why: 'Groups debits by description.' },
    { question: 'How did my balance change over the month?', why: 'Uses the running balance column.' },
    { question: 'How much did I receive from card settlements?', why: 'Card settlements are one of the descriptions in this file.' },
  ],
};

export const AMBIGUOUS_DATES_WARNING =
  'Every date in this file could be read day-first or month-first. We assumed day-first (dd/mm/yyyy), the South African norm. If that is wrong, choose month-first under "Check how we read your file".';

export const AMBIGUOUS: DatasetTemplate = {
  key: '04',
  file_type: 'csv',
  original_filename: '04_ambiguous_dates.csv',
  name: 'Office expenses',
  size_bytes: 820,
  row_count: 30,
  columns: [
    { name: 'Date', type: 'date', distinct: 22, samples: [] },
    { name: 'Item', type: 'text', semantic: 'category', distinct: 5, samples: ['Cleaning', 'Tea and coffee', 'Courier'] },
    { name: 'Amount', type: 'decimal', semantic: 'currency_zar', distinct: 30, min: '60.34', max: '555.44', samples: ['207.72', '375.76', '60.34'] },
  ],
  parse_options: { sheet_name: null, header_row: 1, delimiter: ',', decimal_separator: '.', date_format: 'dmy' },
  sheet_names: [],
  preamble_lines: [],
  excluded_rows: 0,
  warnings: [AMBIGUOUS_DATES_WARNING],
  suggestions: [
    { question: 'What did I spend on each item?', why: 'Totals the amounts by item.' },
    { question: 'Which month had the highest spending?', why: 'Depends on the date order being right.' },
    { question: 'What is my average expense?', why: 'A simple baseline for next month.' },
  ],
  raw_dates: {
    column: 'Date',
    values: ['10/11/2026', '04/04/2026', '05/03/2026', '02/08/2026', '06/12/2026', '05/04/2026', '10/06/2026', '02/07/2026', '05/01/2026', '12/09/2026', '06/10/2026', '12/05/2026', '04/09/2026'],
  },
};

export const FIXTURE_TEMPLATES = [CARD_SALES, WEBSTORE, BANK, AMBIGUOUS];

/** 'dd/mm/yyyy' or 'mm/dd/yyyy' to ISO, by the chosen order. */
export function toIsoDate(raw: string, order: 'dmy' | 'mdy'): string {
  const [a = '', b = '', year = ''] = raw.split('/');
  const [day, month] = order === 'dmy' ? [a, b] : [b, a];
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** Applies the date order to the template's raw dates: min, max and samples change; nothing else does. */
export function applyDateOrder(detail: DatasetDetail, template: DatasetTemplate, order: 'dmy' | 'mdy'): void {
  if (!template.raw_dates) return;
  const column = detail.columns.find((c) => c.name === template.raw_dates?.column);
  if (!column) return;
  const iso = template.raw_dates.values.map((v) => toIsoDate(v, order));
  const sorted = [...iso].sort();
  column.min_value = sorted[0] ?? null;
  column.max_value = sorted[sorted.length - 1] ?? null;
  column.sample_values = iso.slice(0, 3);
}
