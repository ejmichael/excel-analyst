import type { Block, BlockCheck, CellValue, ChartSpec, ResultColumn, ValueFormat } from '../types';
import { formatValue } from '@/lib/format';

/**
 * Example answers for mock mode, themed on the card-sales fixture. Where fixtures/expected.json has a figure
 * (net by store, total net, total fees) the same figure is used; everything else is made-up example data.
 * They are display fixtures only, never presented as real results.
 */

type Row = Record<string, CellValue>;

const STORES: Array<[string, number]> = [
  ['Pietermaritzburg Padstal', 99284.58],
  ['Café Rosé Sandton', 90501.94],
  ['Müller Bakkery Pretoria', 89591.22],
];

const passed = (type: BlockCheck['type'], label: string, extra: Partial<BlockCheck> = {}): BlockCheck => ({
  type,
  ok: true,
  label,
  ...extra,
});

const READ_ONLY = passed('sql_read_only', 'The query only reads your data');
const NUMBERS = passed('numbers_from_data', 'Every number in the explanation comes from the result');
const NOT_TRUNCATED = passed('result_not_truncated', 'The whole result is shown');

function chart(spec: Partial<ChartSpec> & Pick<ChartSpec, 'type'>, formats: Record<string, ValueFormat>): ChartSpec {
  return { x: null, y: [], series: null, orientation: 'vertical', stacked: false, value_format: formats, ...spec };
}

/** Deterministic made-up daily figures for October (example data only). */
function octoberDays(): Row[] {
  return Array.from({ length: 31 }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    const gross = 7200 + ((i * 1733) % 4100) + (i % 7 === 5 ? 3100 : 0);
    const net = Math.round((gross - gross * 0.028) * 100) / 100;
    return { day: `2026-10-${day}`, gross_amount: gross, net_amount: net };
  });
}

export interface BlockTemplate {
  key: string;
  matches: RegExp;
  title: string;
  sql: string;
  columns: ResultColumn[];
  rows: Row[];
  row_count?: number;
  chart: ChartSpec;
  /** Narrative with {name} placeholders filled from the first row, formatted like the server does. */
  narrative: (rows: Row[], rowCount: number) => string;
  follow_ups: string[];
  checks: BlockCheck[];
  has_source_rows: boolean;
}

const fmt = (v: CellValue, f: ValueFormat) => formatValue(v, f);

export const BLOCK_TEMPLATES: BlockTemplate[] = [
  {
    key: 'by-store',
    matches: /store|branch|where/i,
    title: 'Net sales by store',
    sql: 'SELECT "store", SUM("net_amount") AS net_sales\nFROM data\nGROUP BY "store"\nORDER BY net_sales DESC',
    columns: [
      { name: 'store', format: 'text' },
      { name: 'net_sales', format: 'zar' },
    ],
    rows: STORES.map(([store, net]) => ({ store, net_sales: net })),
    chart: chart({ type: 'bar', x: 'store', y: ['net_sales'], orientation: 'horizontal' }, { net_sales: 'zar' }),
    narrative: (rows) =>
      `${rows[0]?.store} had the highest net sales at ${fmt(rows[0]?.net_sales ?? null, 'zar')}, ahead of ${rows[1]?.store} at ${fmt(rows[1]?.net_sales ?? null, 'zar')}.`,
    follow_ups: ['How did each store do week by week?', 'Which store had the most refunds?', 'What were the card fees per store?'],
    checks: [
      READ_ONLY,
      NUMBERS,
      passed('total_reconciles', 'Total of net amount matches your file', { expected: 279377.74, actual: 279377.74 }),
      NOT_TRUNCATED,
    ],
    has_source_rows: false,
  },
  {
    key: 'daily',
    matches: /day|daily|trend|over time|line/i,
    title: 'Net sales per day in October',
    sql: 'SELECT "transaction_date" AS day, SUM("net_amount") AS net_amount\nFROM data\nGROUP BY day\nORDER BY day',
    columns: [
      { name: 'day', format: 'date' },
      { name: 'net_amount', format: 'zar' },
    ],
    rows: octoberDays().map(({ day, net_amount }) => ({ day: day ?? null, net_amount: net_amount ?? null })),
    chart: chart({ type: 'line', x: 'day', y: ['net_amount'] }, { day: 'date', net_amount: 'zar' }),
    narrative: (rows) => `Net sales were ${fmt(rows[0]?.net_amount ?? null, 'zar')} on ${fmt(rows[0]?.day ?? null, 'date')}. The chart shows every day of the month.`,
    follow_ups: ['Which day had the highest sales?', 'How do weekends compare with weekdays?'],
    checks: [READ_ONLY, NUMBERS, NOT_TRUNCATED],
    has_source_rows: false,
  },
  {
    key: 'gross-net',
    matches: /gross|area|compare/i,
    title: 'Gross and net sales per day',
    sql: 'SELECT "transaction_date" AS day, SUM("gross_amount") AS gross_amount, SUM("net_amount") AS net_amount\nFROM data\nGROUP BY day\nORDER BY day',
    columns: [
      { name: 'day', format: 'date' },
      { name: 'gross_amount', format: 'zar' },
      { name: 'net_amount', format: 'zar' },
    ],
    rows: octoberDays(),
    chart: chart({ type: 'area', x: 'day', y: ['gross_amount', 'net_amount'] }, { day: 'date', gross_amount: 'zar', net_amount: 'zar' }),
    narrative: (rows) =>
      `On ${fmt(rows[0]?.day ?? null, 'date')} gross sales were ${fmt(rows[0]?.gross_amount ?? null, 'zar')} and net sales ${fmt(rows[0]?.net_amount ?? null, 'zar')}.`,
    follow_ups: ['How much did card fees cost in total?'],
    checks: [READ_ONLY, NUMBERS, NOT_TRUNCATED],
    has_source_rows: false,
  },
  {
    key: 'card-share',
    matches: /share|split|card type|pie|debit|credit/i,
    title: 'Share of net sales by card type',
    sql: 'SELECT "card_type", SUM("net_amount") / (SELECT SUM("net_amount") FROM data) AS share\nFROM data\nGROUP BY "card_type"\nORDER BY share DESC',
    columns: [
      { name: 'card_type', format: 'text' },
      { name: 'share', format: 'percent' },
    ],
    rows: [
      { card_type: 'DEBIT', share: 0.6184 },
      { card_type: 'CREDIT', share: 0.3816 },
    ],
    chart: chart({ type: 'pie', x: 'card_type', y: ['share'] }, { share: 'percent' }),
    narrative: (rows) => `${rows[0]?.card_type} cards brought in ${fmt(rows[0]?.share ?? null, 'percent')} of net sales.`,
    follow_ups: ['How many transactions were there per card type?'],
    checks: [READ_ONLY, NUMBERS, NOT_TRUNCATED],
    has_source_rows: false,
  },
  {
    key: 'fees',
    matches: /fee|cost|total|how much/i,
    title: 'Total card fees in October',
    sql: 'SELECT SUM("fee") AS total_fees\nFROM data',
    columns: [{ name: 'total_fees', format: 'zar' }],
    rows: [{ total_fees: 8040.79 }],
    chart: chart({ type: 'kpi', y: ['total_fees'] }, { total_fees: 'zar' }),
    narrative: (rows) => `Card fees came to ${fmt(rows[0]?.total_fees ?? null, 'zar')} in October.`,
    follow_ups: ['What were the card fees per store?', 'How do fees compare with last month?'],
    checks: [
      READ_ONLY,
      NUMBERS,
      passed('total_reconciles', 'Total of fee matches your file', { expected: 8040.79, actual: 8040.79 }),
      NOT_TRUNCATED,
    ],
    has_source_rows: false,
  },
  {
    key: 'refunds',
    matches: /refund|negative|list|table|which transactions/i,
    title: 'Refunds in October',
    sql: 'SELECT "transaction_date", "store", "reference", "net_amount"\nFROM data\nWHERE "net_amount" < 0\nORDER BY "transaction_date"',
    columns: [
      { name: 'transaction_date', format: 'date' },
      { name: 'store', format: 'text' },
      { name: 'reference', format: 'text' },
      { name: 'net_amount', format: 'zar' },
    ],
    rows: [
      { transaction_date: '2026-10-03', store: 'Café Rosé Sandton', reference: 'TX20481733', net_amount: -412.5 },
      { transaction_date: '2026-10-08', store: 'Pietermaritzburg Padstal', reference: 'TX55120984', net_amount: -1205.4 },
      { transaction_date: '2026-10-12', store: 'Müller Bakkery Pretoria', reference: 'TX77310452', net_amount: -96 },
      { transaction_date: '2026-10-19', store: 'Café Rosé Sandton', reference: 'TX10937721', net_amount: -250.25 },
      { transaction_date: '2026-10-24', store: 'Pietermaritzburg Padstal', reference: 'TX63388019', net_amount: -742.1 },
      { transaction_date: '2026-10-30', store: 'Müller Bakkery Pretoria', reference: 'TX40021876', net_amount: -318.75 },
    ],
    chart: chart({ type: 'table' }, { transaction_date: 'date', net_amount: 'zar' }),
    narrative: (rows, n) => `There were ${n} refunds. The largest was ${fmt(rows[1]?.net_amount ?? null, 'zar')} at ${rows[1]?.store}.`,
    follow_ups: ['Which store had the most refunds?'],
    checks: [READ_ONLY, NUMBERS, NOT_TRUNCATED],
    has_source_rows: true,
  },
  {
    key: 'store-card',
    matches: /stack|each store and card|by store and/i,
    title: 'Net sales by store and card type',
    sql: 'SELECT "store", "card_type", SUM("net_amount") AS net_sales\nFROM data\nGROUP BY "store", "card_type"\nORDER BY "store", "card_type"',
    columns: [
      { name: 'store', format: 'text' },
      { name: 'card_type', format: 'text' },
      { name: 'net_sales', format: 'zar' },
    ],
    // One combination is absent on purpose: the chart must show a gap, not zero.
    rows: [
      { store: 'Café Rosé Sandton', card_type: 'CREDIT', net_sales: 34120.6 },
      { store: 'Café Rosé Sandton', card_type: 'DEBIT', net_sales: 56381.34 },
      { store: 'Müller Bakkery Pretoria', card_type: 'DEBIT', net_sales: 89591.22 },
      { store: 'Pietermaritzburg Padstal', card_type: 'CREDIT', net_sales: 40212.11 },
      { store: 'Pietermaritzburg Padstal', card_type: 'DEBIT', net_sales: 59072.47 },
    ],
    chart: chart({ type: 'bar', x: 'store', y: ['net_sales'], series: 'card_type', stacked: true }, { net_sales: 'zar' }),
    narrative: (rows) => `${rows[2]?.store} only took debit cards, with net sales of ${fmt(rows[2]?.net_sales ?? null, 'zar')}.`,
    follow_ups: ['Why did one store take no credit cards?'],
    checks: [READ_ONLY, NUMBERS, NOT_TRUNCATED],
    has_source_rows: false,
  },
  {
    key: 'flagged',
    matches: /average|flag|check/i,
    title: 'Average sale per store',
    sql: 'SELECT "store", AVG("gross_amount") AS average_sale\nFROM data\nWHERE "gross_amount" > 0\nGROUP BY "store"',
    columns: [
      { name: 'store', format: 'text' },
      { name: 'average_sale', format: 'zar' },
    ],
    rows: [
      { store: 'Pietermaritzburg Padstal', average_sale: 1241.06 },
      { store: 'Café Rosé Sandton', average_sale: 1131.27 },
      { store: 'Müller Bakkery Pretoria', average_sale: 1119.89 },
    ],
    chart: chart({ type: 'bar', x: 'store', y: ['average_sale'], orientation: 'horizontal' }, { average_sale: 'zar' }),
    narrative: (rows) => `The average sale at ${rows[0]?.store} was ${fmt(rows[0]?.average_sale ?? null, 'zar')}, about 10 more than the others.`,
    follow_ups: ['How many sales did each store make?'],
    checks: [
      READ_ONLY,
      {
        type: 'numbers_from_data',
        ok: false,
        label: 'Every number in the explanation comes from the result',
        detail: 'The explanation contains the number "10", which is not from the result.',
      },
      {
        type: 'total_reconciles',
        ok: false,
        label: 'Total of gross amount matches your file',
        detail: 'Refunds were left out, so the totals differ.',
        expected: 287418.53,
        actual: 291102.08,
      },
      NOT_TRUNCATED,
    ],
    has_source_rows: true,
  },
  {
    key: 'truncated',
    matches: /every transaction|all transactions|many rows|truncat/i,
    title: 'Every transaction in October',
    sql: 'SELECT *\nFROM data\nWHERE "gross_amount" > 0\nORDER BY "transaction_date"',
    columns: [
      { name: 'transaction_date', format: 'date' },
      { name: 'reference', format: 'text' },
      { name: 'gross_amount', format: 'zar' },
    ],
    rows: Array.from({ length: 500 }, (_, i) => ({
      transaction_date: `2026-10-${String((i % 31) + 1).padStart(2, '0')}`,
      reference: `TX${String(10_000_000 + i * 7919).slice(0, 8)}`,
      gross_amount: 120 + ((i * 337) % 2400),
    })),
    row_count: 1240,
    chart: chart({ type: 'table' }, { transaction_date: 'date', gross_amount: 'zar' }),
    narrative: (_rows, n) => `The file has ${n} matching transactions; the first 500 are listed.`,
    follow_ups: ['Which day had the most transactions?'],
    checks: [
      READ_ONLY,
      NUMBERS,
      { type: 'result_not_truncated', ok: false, label: 'The whole result is shown', detail: 'Only the first 500 rows are shown.' },
    ],
    has_source_rows: true,
  },
];

export const DEFAULT_TEMPLATE_KEY = 'by-store';

export function templateForQuestion(question: string, hint?: string): BlockTemplate {
  const byHint: Record<string, string> = { table: 'refunds', bar: 'by-store', line: 'daily', area: 'gross-net', pie: 'card-share', kpi: 'fees' };
  // Specific words first, so "average sale per store" is the average example, not the generic store one.
  const priority = ['flagged', 'truncated', 'refunds', 'store-card', 'card-share', 'gross-net', 'daily', 'fees', 'by-store'];
  const ordered = priority.map((k) => BLOCK_TEMPLATES.find((t) => t.key === k)!);
  const key = (hint && byHint[hint]) || ordered.find((t) => t.matches.test(question))?.key || DEFAULT_TEMPLATE_KEY;
  return BLOCK_TEMPLATES.find((t) => t.key === key)!;
}

export function blockFrom(
  template: BlockTemplate,
  { question, datasetId, source, createdAt }: { question: string; datasetId: string | null; source: Block['source']; createdAt: string },
): Block {
  const rowCount = template.row_count ?? template.rows.length;
  return {
    id: crypto.randomUUID(),
    dataset_id: datasetId,
    question,
    title: template.title,
    sql: template.sql,
    columns: template.columns,
    rows: template.rows,
    row_count: rowCount,
    truncated: rowCount > template.rows.length,
    chart: template.chart,
    narrative: template.narrative(template.rows, rowCount),
    follow_ups: template.follow_ups.slice(0, 3),
    checks: template.checks,
    status: template.checks.some((c) => !c.ok) ? 'flagged' : 'ok',
    source,
    has_source_rows: template.has_source_rows && datasetId !== null,
    created_at: createdAt,
  };
}
