import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { profileFile, type ProfileResult } from '../../src/services/parsing/pipeline.js';
import {
  safeErrorMessage,
  SANDBOX_LIMITS,
  SandboxError,
  type SandboxInput,
  type SandboxSession,
  sandboxInUse,
  withSandbox,
} from '../../src/services/sandbox/sandbox.js';
import { Semaphore } from '../../src/services/sandbox/semaphore.js';
import { checkParseTree, scanSql, SqlRejected, stripLiterals } from '../../src/services/sandbox/validate.js';

const FIXTURES = new URL('../../../fixtures/', import.meta.url);
const expected = JSON.parse(readFileSync(new URL('expected.json', FIXTURES), 'utf8')).files;

let card: ProfileResult;
let input: SandboxInput;
// A canary file a successful escape would read. Its content must never come back.
const canary = join(tmpdir(), `analyst-canary-${randomBytes(6).toString('hex')}.csv`);
const CANARY_SECRET = `secret-${randomBytes(6).toString('hex')}`;

beforeAll(async () => {
  card = await profileFile({
    buffer: readFileSync(new URL('01_card_sales_semicolon_win1252.csv', FIXTURES)),
    fileType: 'csv',
    options: {},
    maxRows: 1_000_000,
  });
  input = { csv: card.normalisedCsv, columns: card.columns };
  writeFileSync(canary, `a\n${CANARY_SECRET}\n`);
});
afterAll(() => rmSync(canary, { force: true }));

const count = (s: SandboxSession) => s.scalar('SELECT count(*) FROM data');

async function rejected(s: SandboxSession, sql: string): Promise<SandboxError> {
  const before = await count(s);
  const err = await s.query(sql).then(
    () => new Error(`accepted: ${sql}`),
    (e: unknown) => e,
  );
  expect(err, sql).toBeInstanceOf(SandboxError);
  expect((err as SandboxError).kind, sql).toBe('rejected');
  expect(String((err as Error).message)).not.toContain(CANARY_SECRET);
  expect(await count(s)).toBe(before); // no state changed
  return err as SandboxError;
}

describe('sandbox: answers come from DuckDB over the normalised file', () => {
  it('reproduces the expected per-store totals', async () => {
    const net = await withSandbox(input, (s) =>
      s.query('SELECT "store", ROUND(SUM("net_amount"), 2) AS net FROM data GROUP BY "store" ORDER BY "store"'),
    );
    const byStore = Object.fromEntries(net.rows.map((r) => [r.store, r.net]));
    expect(byStore).toEqual(expected['01_card_sales_semicolon_win1252.csv'].net_by_store);
    expect(net.columns).toEqual([
      { name: 'store', type: 'VARCHAR' },
      { name: 'net', type: 'DOUBLE' },
    ]);
  });

  it('types columns explicitly (dates are dates, integers come back as numbers)', async () => {
    const r = await withSandbox(input, (s) =>
      s.query('SELECT min("transaction_date") AS first, count(*) AS n, typeof(min("transaction_date")) AS t FROM data'),
    );
    expect(r.rows[0]).toEqual({ first: expected['01_card_sales_semicolon_win1252.csv'].date_range[0], n: 240, t: 'DATE' });
  });

  it('supports CTEs and subqueries over data', async () => {
    const r = await withSandbox(input, (s) =>
      s.query('WITH s AS (SELECT "store", SUM("net_amount") AS v FROM data GROUP BY 1) SELECT count(*) AS n FROM s WHERE v > (SELECT avg("net_amount") FROM data)'),
    );
    expect(r.rows[0]!.n).toBe(3);
  });
});

describe('sandbox escapes (ARCHITECTURE 4): rejected, no file read, no state change', () => {
  const cases = [
    `SELECT * FROM read_csv('/etc/passwd')`,
    `SELECT * FROM read_csv('${canary.replace(/\\/g, '/')}')`,
    `COPY data TO '/tmp/x.csv'`,
    `ATTACH '/tmp/x.db'`,
    `INSTALL httpfs`,
    `PRAGMA database_list`,
    `SELECT 1; DROP TABLE data`,
    `SELECT * FROM information_schema.tables`,
    `SELECT getenv('SUPABASE_SERVICE_ROLE_KEY')`,
    // extra cases from the Part 3 brief
    `SELECT 1 AS a; SELECT 2 AS b`,
    `SELECT 1 /* DROP */ AS a`,
    `SELECT 1 AS a -- DROP TABLE data`,
    `SELECT * FROM "read_csv"('/etc/passwd')`,
    `SELECT * FROM "read_text"('${canary.replace(/\\/g, '/')}')`,
    `SELECT * FROM users`,
    `SELECT * FROM main.data`,
    `SELECT * FROM duckdb_settings()`,
    `SELECT * FROM query('SELECT 1')`,
    `SELECT current_setting('memory_limit') AS m`,
    `SELECT $$ hidden $$ AS a`,
    `SELECT * FROM data WHERE "store" IN (SELECT "name" FROM pg_catalog.pg_tables)`,
    `UPDATE data SET "fee" = 0`,
    `DELETE FROM data`,
    `CALL pragma_version()`,
    `IMPORT DATABASE '/tmp/x'`,
    `CREATE TABLE t AS SELECT 1`,
    `SELECT 1 AS a FROM data UNION ALL SELECT * FROM read_parquet('/x.parquet')`,
  ];

  it.each(cases)('rejects %s', async (sql) => {
    await withSandbox(input, (s) => rejected(s, sql));
  });

  it('rejects a very long query', async () => {
    const long = `SELECT ${Array.from({ length: 900 }, (_, i) => `1 AS c${i}`).join(', ')} FROM data`;
    expect(long.length).toBeGreaterThan(8000);
    const err = await withSandbox(input, (s) => rejected(s, long));
    expect(err.message).toMatch(/too long/);
  });

  it('times out a runaway query at about 10 seconds without breaking the process', async () => {
    const started = Date.now();
    const err = await withSandbox(input, (s) =>
      s.query('SELECT count(*) AS n FROM data a, data b, data c, data d, data e, data f').catch((e: unknown) => e),
    );
    const ms = Date.now() - started;
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).kind).toBe('timeout');
    expect(ms).toBeGreaterThan(9_000);
    expect(ms).toBeLessThan(20_000);
    expect(sandboxInUse()).toBe(0);
    // The next sandbox works normally.
    expect(await withSandbox(input, count)).toBe(240);
  }, 40_000);

  it('stays locked even if validation were bypassed', async () => {
    await withSandbox(input, async (s) => {
      // Reaching past validation on purpose to test the second line of defence.
      const con = (s as unknown as { con: { run: (sql: string) => Promise<unknown> } }).con;
      await expect(con.run(`SELECT * FROM read_csv('${canary.replace(/\\/g, '/')}')`)).rejects.toThrow(/Permission Error|disabled/i);
      await expect(con.run('SET enable_external_access = true')).rejects.toThrow(/lock|configuration/i);
      await expect(con.run('SET lock_configuration = false')).rejects.toThrow(/lock|configuration/i);
      await expect(con.run('INSTALL httpfs')).rejects.toThrow();
    });
  });

  it('deletes its temp file after loading', async () => {
    const before = new Set(readdir());
    await withSandbox(input, async () => {
      expect(readdir().filter((f) => !before.has(f))).toEqual([]);
    });
  });
});

function readdir(): string[] {
  return readdirSync(tmpdir()).filter((f) => f.startsWith('analyst-') && !f.startsWith('analyst-canary'));
}

describe('result caps', () => {
  it('caps at 5 000 rows while executing and reports the true row count', async () => {
    const big = Buffer.from(['n,label', ...Array.from({ length: 100_000 }, (_, i) => `${i},row ${i % 7}`)].join('\n'));
    const r = await withSandbox(
      { csv: big, columns: [{ sql_name: 'n', data_type: 'integer' }, { sql_name: 'label', data_type: 'text' }] },
      (s) => s.query('SELECT "n", "label" FROM data ORDER BY "n"'),
    );
    expect(r.rows).toHaveLength(SANDBOX_LIMITS.resultCap);
    expect(r.rowCount).toBe(100_000);
    expect(r.rows[4999]).toEqual({ n: 4999, label: 'row 1' });
  });

  it('honours a smaller maxRows', async () => {
    const r = await withSandbox(input, (s) => s.query('SELECT "reference" FROM data', { maxRows: 500 }));
    expect(r.rows).toHaveLength(240);
    expect(r.rowCount).toBe(240);
  });

  it('sums a column over all rows without the cap (for reconcile)', async () => {
    const total = await withSandbox(input, (s) => s.aggregateOf('SELECT "store", SUM("net_amount") AS v FROM data GROUP BY 1', 'v', 'sum'));
    expect(total).toBeCloseTo(expected['01_card_sales_semicolon_win1252.csv'].sums.net_amount, 2);
  });
});

describe('columns named like keywords', () => {
  const kw: SandboxInput = {
    csv: Buffer.from('Update,Call,Import\n1,2,3\n4,5,6\n'),
    columns: [
      { sql_name: 'Update', data_type: 'integer' },
      { sql_name: 'Call', data_type: 'integer' },
      { sql_name: 'Import', data_type: 'integer' },
    ],
  };

  it('can be queried when quoted', async () => {
    const r = await withSandbox(kw, (s) => s.query('SELECT SUM("Update") AS u, SUM("Call") AS c, SUM("Import") AS i FROM data'));
    expect(r.rows[0]).toEqual({ u: 5, c: 7, i: 9 });
  });

  it('while the real statements are rejected', async () => {
    await withSandbox(kw, async (s) => {
      await rejected(s, 'UPDATE data SET "Update" = 0');
      await rejected(s, 'CALL pragma_version()');
      await rejected(s, `IMPORT DATABASE '/tmp/x'`);
      await rejected(s, 'SELECT Update FROM data');
    });
  });
});

describe('validation helpers', () => {
  it('blanks literals and quoted identifiers but keeps the SQL around them', () => {
    expect(stripLiterals(`SELECT 'drop; --' AS "Update" FROM data`)).toBe(`SELECT '        ' AS "      " FROM data`);
    expect(() => stripLiterals(`SELECT 'it''s' AS a`)).not.toThrow();
    expect(() => stripLiterals(`SELECT 'open`)).toThrow(SqlRejected);
  });

  it('allows $1 parameters but not dollar quoting', () => {
    expect(() => scanSql('SELECT * FROM data WHERE "fee" = $1 LIMIT $2')).not.toThrow();
    expect(() => scanSql('SELECT $tag$x$tag$ AS a')).toThrow(SqlRejected);
  });

  it('rejects a parse error with the parser message', () => {
    expect(() => checkParseTree({ error: true, error_message: 'Parser Error: syntax error at or near "FORM"' })).toThrow(/syntax error/);
  });

  it('redacts quoted literals (possible cell values) and the SQL echo from DuckDB errors', () => {
    const raw = `Conversion Error: Could not convert string 'Thandi Nkosi' to INT32\n\nLINE 1: SELECT CAST("name" AS INTEGER)`;
    expect(safeErrorMessage(raw)).toBe(`Conversion Error: Could not convert string '…' to INT32`);
  });
});

describe('concurrency', () => {
  it('a semaphore hands slots over in order and times out', async () => {
    const sem = new Semaphore(1);
    const first = await sem.acquire(1000);
    const waited = sem.acquire(1000);
    const timedOut = await sem.acquire(10);
    expect(timedOut).toBeNull();
    first!();
    const second = await waited;
    expect(second).toBeTypeOf('function');
    second!();
    expect(sem.inUse).toBe(0);
  });

  it('runs at most 2 sandboxes; a third that waits too long is 429 rate_limited', async () => {
    const saved = SANDBOX_LIMITS.maxWaitMs;
    SANDBOX_LIMITS.maxWaitMs = 200;
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    try {
      const busy = [withSandbox(input, () => hold), withSandbox(input, () => hold)];
      await new Promise((r) => setTimeout(r, 50));
      const third = await withSandbox(input, count).catch((e: unknown) => e);
      expect(third).toBeInstanceOf(AppError);
      expect((third as AppError).code).toBe('rate_limited');
      release();
      await Promise.all(busy);
      expect(sandboxInUse()).toBe(0);
    } finally {
      SANDBOX_LIMITS.maxWaitMs = saved;
      release?.();
    }
  });
});
