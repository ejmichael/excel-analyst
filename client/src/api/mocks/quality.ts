import type { DatasetDetail, DatasetQuality, QualityIssue, QualityPart, QualityPartKey } from '../types';

/**
 * Mock data quality: fixed results per example file, one for each band, so every state of the Quality tab can be
 * seen without the server. The real server computes these from the file; these numbers are only examples.
 */
type Example = { score: number; band: DatasetQuality['band']; parts: Record<QualityPartKey, [number, string]>; issues: Array<Omit<QualityIssue, 'id' | 'column'> & { column: string | null }> };

const CLEAN: Example['parts'] = {
  missing: [100, 'none found'],
  duplicates: [100, 'none found'],
  types: [100, 'none found'],
  odd_values: [100, 'none found'],
  consistency: [100, 'none found'],
};

const EXAMPLES: Record<string, Example> = {
  // Card sales: good, with a few things to tidy.
  '01': {
    score: 85,
    band: 'good',
    parts: {
      missing: [80, '48 empty cells'],
      duplicates: [100, 'none found'],
      types: [100, 'none found'],
      odd_values: [70, '2 extreme values'],
      consistency: [70, 'card type written in two ways'],
    },
    issues: [
      {
        kind: 'inconsistent_case',
        severity: 'medium',
        column: 'Card Type',
        title: 'The same card type is written in different ways',
        detail: '“DEBIT” and “debit” look like the same value written two ways, so they may be counted apart.',
        affected_rows: 31,
        examples: ['debit', 'Debit', 'DEBIT'],
      },
      {
        kind: 'missing_values',
        severity: 'low',
        column: 'Terminal',
        title: 'Some terminals are empty',
        detail: 'These rows have no terminal. Answers that group by terminal show them as (blank).',
        affected_rows: 48,
        examples: [],
      },
      {
        kind: 'extreme_values',
        severity: 'low',
        column: 'Gross Amount',
        title: 'Two amounts are far from the rest',
        detail: 'They may be real, or a typing mistake. Check them in your file.',
        affected_rows: 2,
        examples: ['24 981,20', '-12 054,00'],
      },
    ],
  },
  // Webstore orders: needs attention; one issue is in a private column, so it has no examples.
  '02': {
    score: 70,
    band: 'needs_attention',
    parts: {
      missing: [60, '216 empty cells'],
      duplicates: [55, '27 extra copies of rows'],
      types: [100, 'none found'],
      odd_values: [100, 'none found'],
      consistency: [40, 'spaces around email addresses'],
    },
    issues: [
      {
        kind: 'duplicate_rows',
        severity: 'high',
        column: null,
        title: 'Some orders appear more than once',
        detail: 'These rows are exact copies of another row. Totals count them again.',
        affected_rows: 27,
        examples: [],
      },
      {
        kind: 'stray_whitespace',
        severity: 'medium',
        column: 'Customer email',
        title: 'Some email addresses have spaces around them',
        detail: 'The spaces are invisible but make the same address look like two different ones.',
        affected_rows: 108,
        examples: [],
      },
      {
        kind: 'missing_values',
        severity: 'medium',
        column: 'Province',
        title: 'Some provinces are empty',
        detail: 'These orders have no province.',
        affected_rows: 72,
        examples: [],
      },
    ],
  },
  // Office expenses: needs cleaning first.
  '04': {
    score: 34,
    band: 'needs_cleaning',
    parts: {
      missing: [10, '27 empty cells'],
      duplicates: [40, '6 extra copies of rows'],
      types: [30, 'numbers and text mixed in Amount'],
      odd_values: [50, '3 impossible dates'],
      consistency: [60, 'items written in different ways'],
    },
    issues: [
      {
        kind: 'mixed_types',
        severity: 'high',
        column: 'Amount',
        title: 'Some amounts are text, not numbers',
        detail: 'These cells hold words or symbols where a number is expected, so they are left out of totals.',
        affected_rows: 11,
        examples: ['R207,72', 'n/a', 'see slip'],
      },
      {
        kind: 'impossible_dates',
        severity: 'high',
        column: 'Date',
        title: 'Some dates cannot exist',
        detail: 'For example the 31st of a month with 30 days.',
        affected_rows: 3,
        examples: ['31/09/2026', '30/02/2026'],
      },
      {
        kind: 'inconsistent_case',
        severity: 'low',
        column: 'Item',
        title: 'Items are written in different ways',
        detail: '“Tea and coffee” and “tea and coffee” look like the same item.',
        affected_rows: 9,
        examples: ['tea and coffee', 'Tea and Coffee'],
      },
    ],
  },
};

const ORDER: QualityPartKey[] = ['missing', 'duplicates', 'types', 'odd_values', 'consistency'];

/** The quality the mock server returns for a ready file made from `templateKey` (or a clean result). */
export function mockQuality(detail: DatasetDetail, templateKey: string | null): DatasetQuality {
  const example = EXAMPLES[templateKey ?? ''] ?? { score: 100, band: 'very_clean' as const, parts: CLEAN, issues: [] };
  const sqlName = (name: string | null) => (name === null ? null : (detail.columns.find((c) => c.name === name)?.sql_name ?? null));
  const parts: QualityPart[] = ORDER.map((key) => ({ key, score: example.parts[key][0], note: example.parts[key][1] }));
  return {
    dataset_id: detail.id,
    score: example.score,
    band: example.band,
    parts,
    issues: example.issues.map((issue) => {
      const column = sqlName(issue.column);
      const pii = detail.columns.find((c) => c.sql_name === column)?.is_pii ?? false;
      return { ...issue, id: `${issue.kind}:${column ?? '_'}`, column, examples: pii ? [] : issue.examples };
    }),
    rows_checked: detail.row_count ?? 0,
    computed_at: detail.created_at,
  };
}
