import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcileSkipReason } from '../../src/services/analysis/reconcileGuard.js';
import { profileFile } from '../../src/services/parsing/pipeline.js';
import { type SandboxSession, withSandbox } from '../../src/services/sandbox/sandbox.js';
import type { ValueFormat } from '../../src/types/api.js';

/**
 * The reconcile false-alarm guard (user decision 2026-11-13), over DuckDB's real parse tree. Synthetic data: 13 orders,
 * 3 of them with no store.
 */

let session: SandboxSession;
let release: () => void;

beforeAll(async () => {
  const stores = ['North', 'North', 'South', 'South', 'South', 'East', 'East', 'West', 'West', 'West', '', '', ''];
  const csv = `Order,Store,Customer,Amount,Cost,Paid\n${stores.map((s, i) => `${1000 + i},${s},C${i % 5},${(i + 1) * 10}.50,${i + 1}.25,${i % 3 === 0 ? 'no' : 'yes'}`).join('\n')}\n`;
  const p = await profileFile({ buffer: Buffer.from(csv), fileType: 'csv', options: {}, maxRows: 1000 });
  // Hold one sandbox open for the whole file.
  await new Promise<void>((ready) => {
    void withSandbox({ csv: p.normalisedCsv, columns: p.columns }, (s) => {
      session = s;
      ready();
      return new Promise<void>((done) => {
        release = done;
      });
    });
  });
});
afterAll(() => release?.());

const reasonFor = async (sql: string, column: string, format: ValueFormat = 'number') => {
  const result = await session.query(sql);
  const valueFormat: Record<string, ValueFormat> = Object.fromEntries(result.columns.map((c) => [c.name, c.name === column ? format : 'text']));
  return reconcileSkipReason({ tree: await session.parseTree(sql), column, valueFormat, rowCount: result.rowCount });
};

describe('reconcile guard: discards columns that cannot be added up across groups', () => {
  it.each([
    ['COUNT(DISTINCT)', 'SELECT "store", COUNT(DISTINCT "customer") AS v FROM data GROUP BY 1', 'count_distinct'],
    ['AVG', 'SELECT "store", AVG("amount") AS v FROM data GROUP BY 1', 'non_additive_aggregate'],
    ['ROUND(AVG)', 'SELECT "store", ROUND(AVG("amount"), 2) AS v FROM data GROUP BY 1', 'non_additive_aggregate'],
    ['MIN', 'SELECT "store", MIN("amount") AS v FROM data GROUP BY 1', 'non_additive_aggregate'],
    ['MAX', 'SELECT "store", MAX("amount") AS v FROM data GROUP BY 1', 'non_additive_aggregate'],
    ['MEDIAN', 'SELECT "store", MEDIAN("amount") AS v FROM data GROUP BY 1', 'non_additive_aggregate'],
    ['STDDEV', 'SELECT "store", STDDEV("amount") AS v FROM data GROUP BY 1', 'non_additive_aggregate'],
    ['a ratio', 'SELECT "store", SUM("amount") / NULLIF(SUM("cost"), 0) AS v FROM data GROUP BY 1', 'derived_value'],
    ['an average as SUM / COUNT', 'SELECT "store", ROUND(SUM("amount") / COUNT(*), 2) AS v FROM data GROUP BY 1', 'derived_value'],
    ['a percentage by arithmetic', 'SELECT "store", 100.0 * SUM("amount") / (SELECT SUM("amount") FROM data) AS v FROM data GROUP BY 1', 'derived_value'],
    ['a share of total (window)', 'SELECT "store", SUM("amount") / SUM(SUM("amount")) OVER () AS v FROM data GROUP BY 1', 'derived_value'],
    ['a window sum', 'SELECT "store", SUM(SUM("amount")) OVER () AS v FROM data GROUP BY 1', 'window_function'],
    ['SUM(DISTINCT)', 'SELECT "store", SUM(DISTINCT "amount") AS v FROM data GROUP BY 1', 'distinct_aggregate'],
    ['a DISTINCT aggregate in a CTE', 'WITH t AS (SELECT "store", COUNT(DISTINCT "customer") AS n FROM data GROUP BY 1) SELECT "store", n AS v FROM t', 'count_distinct'],
    ['AVG in a subquery', 'SELECT q."store", q.a AS v FROM (SELECT "store", AVG("amount") AS a FROM data GROUP BY 1) q', 'non_additive_aggregate'],
    ['ROLLUP (overlapping groups)', 'SELECT "store", SUM("amount") AS v FROM data GROUP BY ROLLUP ("store")', 'overlapping_groups'],
    ['HAVING drops groups', 'SELECT "store", SUM("amount") AS v FROM data GROUP BY 1 HAVING SUM("amount") > 50', 'filtered_groups'],
    ['a top-N that fills its LIMIT', 'SELECT "store", SUM("amount") AS v FROM data GROUP BY 1 ORDER BY v DESC LIMIT 2', 'limited_result'],
    ['a top-N of raw rows', 'SELECT "customer", "amount" AS v FROM data ORDER BY "amount" DESC LIMIT 5', 'limited_result'],
    ['a group key', 'SELECT "customer" AS v, COUNT(*) AS n FROM data GROUP BY 1', 'derived_value'],
  ])('%s', async (_name, sql, reason) => {
    expect(await reasonFor(sql, 'v')).toBe(reason);
  });

  it('a column formatted as percent is never added up', async () => {
    expect(await reasonFor('SELECT "store", SUM("amount") AS v FROM data GROUP BY 1', 'v', 'percent')).toBe('percent_column');
  });
});

describe('reconcile guard: keeps plain sums and counts over disjoint groups', () => {
  it.each([
    ['SUM by group', 'SELECT "store", SUM("amount") AS v FROM data GROUP BY 1'],
    ['ROUND(SUM)', 'SELECT "store", ROUND(SUM("amount"), 2) AS v FROM data GROUP BY 1 ORDER BY v DESC'],
    ['COUNT(*) by group', 'SELECT "store", COUNT(*) AS v FROM data GROUP BY 1'],
    ['COUNT with FILTER', 'SELECT "store", COUNT(*) FILTER (WHERE "paid") AS v FROM data GROUP BY 1'],
    ['a sum with a WHERE filter', 'SELECT "store", SUM("amount") AS v FROM data WHERE "paid" GROUP BY 1'],
    ['by month', `SELECT date_trunc('month', DATE '2026-10-01') AS m, SUM("amount") AS v FROM data GROUP BY 1`],
    ['CAST(COALESCE(SUM, 0))', 'SELECT "store", CAST(COALESCE(SUM("amount"), 0) AS DOUBLE) AS v FROM data GROUP BY 1'],
    ['through a CTE', 'WITH t AS (SELECT "store", SUM("amount") AS s FROM data GROUP BY 1) SELECT "store", s AS v FROM t ORDER BY s DESC'],
    ['through a subquery', 'SELECT q."store", q.s AS v FROM (SELECT "store", SUM("amount") AS s FROM data GROUP BY 1) q'],
    ['a LIMIT the result does not fill', 'SELECT "store", COUNT(*) AS v FROM data GROUP BY 1 ORDER BY v DESC LIMIT 50'],
    ['a single total', 'SELECT SUM("amount") AS v FROM data'],
  ])('%s', async (_name, sql) => {
    expect(await reasonFor(sql, 'v')).toBeNull();
  });

  it('unaliased column references resolve by name', async () => {
    expect(await reasonFor('WITH t AS (SELECT "store", SUM("amount") AS v FROM data GROUP BY 1) SELECT "store", v FROM t', 'v')).toBeNull();
  });
});
