import { describe, expect, it } from 'vitest';
import { bandFor, computeQuality, latestPossibleDate, type QualityColumn } from '../../src/services/quality.js';
import { withSandbox } from '../../src/services/sandbox/sandbox.js';

const col = (sql_name: string, data_type: QualityColumn['data_type'], semantic: QualityColumn['semantic'] = 'none', is_pii = false): QualityColumn => ({
  sql_name,
  label: sql_name,
  data_type,
  semantic,
  is_pii,
});

const csvOf = (header: string[], rows: string[][]) =>
  Buffer.from(`${header.join(',')}\n${rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n')}\n`);

async function quality(columns: QualityColumn[], csv: Buffer, now = new Date('2026-11-19T10:00:00Z')) {
  return withSandbox({ csv, columns }, (s) => computeQuality(s, columns, now));
}

// ---------- the dirty file: 37 distinct rows plus 3 exact copies = 40 rows, 8 columns ----------
const DIRTY_COLUMNS = [
  col('id', 'integer'),
  col('job', 'text', 'category'),
  col('city', 'text', 'category'),
  col('amount', 'decimal', 'currency_zar'),
  col('code', 'text', 'identifier'),
  col('day', 'date'),
  col('website', 'text'),
  col('email', 'text', 'email', true),
];
const dirtyRows = Array.from({ length: 37 }, (_, i) => [
  String(i + 1),
  i % 4 === 0 ? (i === 8 || i === 16 ? 'ops manager' : 'Ops Manager') : 'Cashier', // 2 minority spellings
  i === 5 || i === 6 ? 'Durban ' : 'Durban', // 2 trailing spaces
  i === 20 || i === 21 || i === 22 ? '' : i === 10 ? '99999' : String(100 + i), // 3 empty, 1 extreme
  i === 30 ? 'N/A' : i === 31 ? 'unknown' : String(1000 + i), // 38 of 40 numbers
  i === 12 ? '1985-03-01' : `2026-10-${String((i % 28) + 1).padStart(2, '0')}`, // 1 impossible date
  `${i >= 33 && i <= 35 ? 'http' : 'https'}://shop${i}.co.za`, // 3 http among https
  i === 36 ? '' : i === 7 ? `p${i}@example.com ` : `p${i}@example.com`, // PII: 1 empty, 1 trailing space
]);
const DIRTY = csvOf(
  DIRTY_COLUMNS.map((c) => c.sql_name),
  [...dirtyRows, dirtyRows[0]!, dirtyRows[1]!, dirtyRows[2]!],
);

describe('quality: a dirty file with known counts', () => {
  it('finds every issue with the exact rows affected, most severe first', async () => {
    const r = await quality(DIRTY_COLUMNS, DIRTY);
    expect(r.rows_checked).toBe(40);
    expect(r.issues.map((i) => [i.id, i.severity, i.affected_rows])).toEqual([
      ['duplicate_rows:_', 'medium', 3],
      ['missing_values:amount', 'medium', 3],
      ['mixed_url_scheme:website', 'medium', 3],
      ['mixed_types:code', 'medium', 2],
      ['impossible_dates:day', 'medium', 1],
      ['inconsistent_case:job', 'low', 2],
      ['stray_whitespace:city', 'low', 2],
      ['extreme_values:amount', 'low', 1],
      ['missing_values:email', 'low', 1],
      ['stray_whitespace:email', 'low', 1],
    ]);
  });

  it('part scores, overall score and band follow the rules', async () => {
    const r = await quality(DIRTY_COLUMNS, DIRTY);
    // missing: 4 of 320 cells = 1.25% -> 100 - 3.75; duplicates: 3 of 40 = 7.5% -> 100 - 22.5;
    // types: 2 of 40 = 5% -> 90; odd values: 1 + 1 of 40 = 5% -> 90; consistency: 2 + 2 + 1 + 3 of 40 = 20% -> 80.
    expect(r.parts).toEqual([
      { key: 'missing', score: 96, note: '4 empty cells' },
      { key: 'duplicates', score: 78, note: '3 extra copies' },
      { key: 'types', score: 90, note: '2 values of another type' },
      { key: 'odd_values', score: 90, note: '2 unusual values' },
      { key: 'consistency', score: 80, note: '8 values written inconsistently' },
    ]);
    // (96*30 + 78*20 + 90*20 + 90*15 + 80*15) / 100 = 87.9
    expect(r.score).toBe(88);
    expect(r.band).toBe('good');
  });

  it('examples: empty for the PII column, at most 3 elsewhere, and real values from the file', async () => {
    const r = await quality(DIRTY_COLUMNS, DIRTY);
    const byId = new Map(r.issues.map((i) => [i.id, i]));
    expect(byId.get('stray_whitespace:email')!.examples).toEqual([]);
    expect(byId.get('missing_values:email')!.examples).toEqual([]);
    for (const i of r.issues) expect(i.examples.length).toBeLessThanOrEqual(3);
    expect(byId.get('inconsistent_case:job')!.examples).toEqual(['Ops Manager', 'ops manager']);
    expect(byId.get('stray_whitespace:city')!.examples).toEqual(['Durban ']);
    expect(byId.get('mixed_types:code')!.examples).toEqual(['N/A', 'unknown']);
    expect(byId.get('extreme_values:amount')!.examples).toEqual(['99999']);
    expect(byId.get('impossible_dates:day')!.examples).toEqual(['1985-03-01']);
    expect(byId.get('mixed_url_scheme:website')!.examples).toEqual(['http://shop33.co.za', 'http://shop34.co.za', 'http://shop35.co.za']);
    expect(byId.get('duplicate_rows:_')!.column).toBeNull();
  });

  it('the same file always gives the same result', async () => {
    const [a, b] = [await quality(DIRTY_COLUMNS, DIRTY), await quality(DIRTY_COLUMNS, DIRTY)];
    expect(a).toEqual(b);
  });
});

describe('quality: a clean file', () => {
  it('scores exactly 100 with every part "none found"', async () => {
    const columns = [col('day', 'date'), col('store', 'text', 'category'), col('amount', 'decimal'), col('units', 'integer')];
    const rows = Array.from({ length: 30 }, (_, i) => [`2026-10-${String(i + 1).padStart(2, '0')}`, ['Durban', 'Cape Town', 'Pretoria'][i % 3]!, String(100 + i * 2.5), String(10 + (i % 7))]);
    const r = await quality(columns, csvOf(columns.map((c) => c.sql_name), rows));
    expect(r).toMatchObject({ score: 100, band: 'very_clean', issues: [], rows_checked: 30 });
    expect(r.parts.map((p) => p.note)).toEqual(Array(5).fill('none found'));
    expect(r.parts.every((p) => p.score === 100)).toBe(true);
  });
});

describe('quality: rules at the edges', () => {
  it('a column empty in every row is high', async () => {
    const columns = [col('a', 'text'), col('b', 'text')];
    const r = await quality(columns, csvOf(['a', 'b'], [['x', ''], ['y', '']]));
    expect(r.issues.find((i) => i.id === 'missing_values:b')).toMatchObject({ severity: 'high', affected_rows: 2 });
  });

  it('extreme values need at least 20 values in the column', async () => {
    const columns = [col('n', 'integer')];
    const nineteen = Array.from({ length: 19 }, (_, i) => [String(i === 0 ? 1_000_000 : 10 + i)]);
    expect((await quality(columns, csvOf(['n'], nineteen))).issues).toEqual([]);
    const twenty = [...nineteen, ['30']];
    expect((await quality(columns, csvOf(['n'], twenty))).issues.map((i) => i.id)).toEqual(['extreme_values:n']);
  });

  it('impossible dates: before 1990 or more than 366 days after today (SAST)', async () => {
    expect(latestPossibleDate(new Date('2026-11-18T22:30:00Z'))).toBe('2027-11-20'); // already 19 Nov in SAST
    const columns = [col('d', 'date')];
    const r = await quality(columns, csvOf(['d'], [['1989-12-31'], ['1990-01-01'], ['2027-11-20'], ['2027-11-21']]), new Date('2026-11-18T22:30:00Z'));
    expect(r.issues[0]).toMatchObject({ id: 'impossible_dates:d', affected_rows: 2 });
  });

  it('URLs: only when at least 80% of values are links and both schemes occur', async () => {
    const columns = [col('u', 'text')];
    const mostlyText = [['http://a.co.za'], ['https://b.co.za'], ['note'], ['note 2'], ['note 3']];
    expect((await quality(columns, csvOf(['u'], mostlyText))).issues.map((i) => i.kind)).not.toContain('mixed_url_scheme');
    const allHttps = [['https://a.co.za'], ['https://b.co.za']];
    expect((await quality(columns, csvOf(['u'], allHttps))).issues).toEqual([]);
  });

  it('inconsistent case is not checked for names, emails, phones, IDs, addresses or free text', async () => {
    const columns = [col('who', 'text', 'person_name', true)];
    const r = await quality(columns, csvOf(['who'], [['Thandi Nkosi'], ['thandi nkosi']]));
    expect(r.issues).toEqual([]);
  });

  it('a style problem never zeroes the part: 9 of 25 rows written differently leaves consistency at 64', async () => {
    const columns = [col('t', 'text', 'category')];
    const rows = Array.from({ length: 25 }, (_, i) => [i < 9 ? 'ops manager' : 'Ops Manager']);
    const r = await quality(columns, csvOf(['t'], rows));
    expect(r.parts.find((p) => p.key === 'consistency')).toEqual({ key: 'consistency', score: 64, note: '9 values written inconsistently' });
  });

  it.each([
    [90, 'very_clean'],
    [89, 'good'],
    [75, 'good'],
    [74, 'needs_attention'],
    [50, 'needs_attention'],
    [49, 'needs_cleaning'],
  ] as const)('band of %d is %s', (score, band) => {
    expect(bandFor(score)).toBe(band);
  });
});
