import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { CellValue, ColumnDataType } from '../../types/api.js';
import { Semaphore } from './semaphore.js';
import { checkParseTree, scanSql, SqlRejected } from './validate.js';

/**
 * The SQL sandbox (ARCHITECTURE section 4). Every query on user data (ask, repair, reconcile, source rows) runs
 * through `withSandbox` + `SandboxSession.query`:
 * - a fresh in-memory DuckDB per use, 512 MB memory, 2 threads, no spilling to disk, no extension auto-install or
 *   auto-load, no community extensions, no persistent secrets;
 * - the normalised CSV is written to a random temp file (mode 600), loaded with explicit column types, and deleted
 *   straight after loading (and again in `finally`); then external access is turned off and the configuration locked;
 * - each query is validated (lexical scan + parse-tree walk), run with a 10 s timeout and a 5 000-row cap, and its true
 *   row count comes from count(*) over the same query;
 * - at most 2 sandboxes run at once per process; waiting longer than 20 s is 429 rate_limited.
 * Never logs the path, the SQL, the results or the file contents.
 */

export const SANDBOX_LIMITS = {
  memoryLimit: '512MB',
  threads: 2,
  timeoutMs: 10_000,
  resultCap: 5_000,
  maxConcurrent: 2,
  maxWaitMs: 20_000,
};

/**
 * A fixed category for why a query failed, safe to log: it never contains SQL, values or error text.
 * Used in usage_events meta so repair patterns can be counted later.
 */
export type SandboxErrorCategory =
  | 'sql_rejected'
  | 'timeout'
  | 'duckdb_parse_error'
  | 'unknown_column'
  | 'duckdb_binder_error'
  | 'unknown_function_or_table'
  | 'type_conversion_error'
  | 'out_of_range'
  | 'duplicate_column'
  | 'duckdb_error';

/** Maps a raw DuckDB error message to its category (the message itself is never stored). */
export function categoriseDuckDbError(raw: string): SandboxErrorCategory {
  if (/^Parser Error/i.test(raw)) return 'duckdb_parse_error';
  if (/^Binder Error/i.test(raw) && /column/i.test(raw)) return 'unknown_column';
  if (/^Binder Error/i.test(raw)) return 'duckdb_binder_error';
  if (/^Catalog Error/i.test(raw)) return 'unknown_function_or_table';
  if (/^Conversion Error|Could not convert/i.test(raw)) return 'type_conversion_error';
  if (/^Out of Range Error/i.test(raw)) return 'out_of_range';
  return 'duckdb_error';
}

/** Why a query did not produce a result. `message` is DuckDB's or ours, with quoted literals redacted (no data). */
export class SandboxError extends Error {
  readonly category: SandboxErrorCategory;
  constructor(
    readonly kind: 'rejected' | 'failed' | 'timeout',
    message: string,
    category?: SandboxErrorCategory,
  ) {
    super(message);
    this.name = 'SandboxError';
    this.category = category ?? (kind === 'rejected' ? 'sql_rejected' : kind === 'timeout' ? 'timeout' : 'duckdb_error');
  }
}

export interface SandboxColumn {
  sql_name: string;
  data_type: ColumnDataType;
}

export interface QueryResult {
  columns: Array<{ name: string; type: string }>;
  /** At most `maxRows` rows (default 5 000). */
  rows: Array<Record<string, CellValue>>;
  /** The true number of rows the query returns. */
  rowCount: number;
}

const DUCK_TYPES: Record<ColumnDataType, string> = {
  integer: 'BIGINT',
  decimal: 'DOUBLE',
  date: 'DATE',
  datetime: 'TIMESTAMP',
  boolean: 'BOOLEAN',
  text: 'VARCHAR',
};

const semaphore = new Semaphore(SANDBOX_LIMITS.maxConcurrent);

/** DuckDB error text minus anything that could be a cell value: quoted literals are redacted, the SQL echo is dropped. */
export function safeErrorMessage(raw: string): string {
  return raw
    .split(/\n\s*LINE \d+:/)[0]!
    .replace(/'(?:[^']|'')*'/g, "'…'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function toCell(value: unknown, type: string): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    if (/^(BIGINT|HUGEINT|UBIGINT|UHUGEINT|INTEGER|SMALLINT|TINYINT|UINTEGER|USMALLINT|UTINYINT|DECIMAL)/.test(type)) {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    if (/^TIMESTAMP/.test(type)) return value.replace(' ', 'T').replace(/(\.\d+)?([+-]\d\d(:\d\d)?)?$/, '');
    return value;
  }
  return JSON.stringify(value);
}

export class SandboxSession {
  constructor(private readonly con: DuckDBConnection) {}

  private async withTimeout<T>(run: () => Promise<T>): Promise<T> {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.con.interrupt();
    }, SANDBOX_LIMITS.timeoutMs);
    try {
      return await run();
    } catch (err) {
      if (timedOut) throw new SandboxError('timeout', 'The query took longer than 10 seconds and was stopped.');
      if (err instanceof SandboxError) throw err;
      const raw = err instanceof Error ? err.message : String(err);
      throw new SandboxError('failed', safeErrorMessage(raw), categoriseDuckDbError(raw));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Both validation layers. Throws SandboxError('rejected'). */
  async validate(sql: string): Promise<void> {
    try {
      scanSql(sql);
      const reader = await this.con.runAndReadAll('SELECT json_serialize_sql($1::VARCHAR) AS s', [sql]);
      const serialized = reader.getRowObjectsJson()[0]?.s;
      checkParseTree(JSON.parse(String(serialized)));
    } catch (err) {
      if (err instanceof SqlRejected) throw new SandboxError('rejected', err.reason, err.parseError ? 'duckdb_parse_error' : 'sql_rejected');
      throw new SandboxError('rejected', 'The query could not be checked.');
    }
  }

  /**
   * Validates and runs one SELECT. Returns at most `maxRows` rows (capped while executing) and the true row count.
   * `params` bind to $1, $2, ... in the query.
   */
  async query(sql: string, opts: { maxRows?: number; params?: DuckDBValue[] } = {}): Promise<QueryResult> {
    await this.validate(sql);
    const maxRows = Math.min(opts.maxRows ?? SANDBOX_LIMITS.resultCap, SANDBOX_LIMITS.resultCap);
    const inner = sql.trim();
    return this.withTimeout(async () => {
      const reader = await this.con.runAndReadAll(`SELECT * FROM (${inner}) AS sandbox_q LIMIT ${maxRows}`, opts.params ?? []);
      const names = reader.columnNames();
      if (new Set(names).size !== names.length) {
        throw new SandboxError('failed', 'Two result columns have the same name; give each column a unique alias.', 'duplicate_column');
      }
      const types = reader.columnTypes().map((t) => t.toString());
      const rows = reader.getRowObjectsJson().map((r) => {
        const out: Record<string, CellValue> = {};
        names.forEach((name, i) => {
          out[name] = toCell(r[name], types[i]!);
        });
        return out;
      });
      const counted = await this.con.runAndReadAll(`SELECT count(*) AS n FROM (${inner}) AS sandbox_q`, opts.params ?? []);
      const rowCount = Number(counted.getRowObjectsJson()[0]?.n ?? rows.length);
      return { columns: names.map((name, i) => ({ name, type: types[i]! })), rows, rowCount };
    });
  }

  /** A single number from a single-value SELECT (reconcile totals), or null when the query returns NULL. */
  async scalar(sql: string): Promise<number | null> {
    const result = await this.query(sql, { maxRows: 2 });
    if (result.rowCount !== 1 || result.columns.length !== 1) {
      throw new SandboxError('failed', 'The total query must return exactly one value.');
    }
    const value = result.rows[0]![result.columns[0]!.name];
    if (value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new SandboxError('failed', 'The total query did not return a number.');
    return n;
  }

  /**
   * The sum of one column over ALL rows of a query, without the row cap (for reconcile). Always a sum: in a breakdown
   * by group, a count per group must add up to the table's count just as a sum per group adds up to its total.
   * (Counting the column's values would count the groups instead.) Rows with a NULL group key are included.
   */
  async sumOf(sql: string, column: string): Promise<number | null> {
    await this.validate(sql);
    const quoted = `"${column.replace(/"/g, '""')}"`;
    return this.withTimeout(async () => {
      const reader = await this.con.runAndReadAll(`SELECT sum(${quoted}) AS v FROM (${sql.trim()}) AS sandbox_q`);
      const v = reader.getRowObjectsJson()[0]?.v;
      if (v === null || v === undefined) return null;
      return Number(v);
    });
  }
}

export interface SandboxInput {
  /** The normalised CSV (header = sql_names). */
  csv: Buffer;
  columns: SandboxColumn[];
}

async function openSession(input: SandboxInput): Promise<{ session: SandboxSession; close: () => void }> {
  const instance = await DuckDBInstance.create(':memory:', {
    memory_limit: SANDBOX_LIMITS.memoryLimit,
    threads: String(SANDBOX_LIMITS.threads),
    max_temp_directory_size: '0B', // never spill user data to disk
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
    allow_community_extensions: 'false',
    allow_unsigned_extensions: 'false',
    allow_persistent_secrets: 'false',
  });
  let con: DuckDBConnection | undefined;
  const path = join(tmpdir(), `analyst-${randomBytes(16).toString('hex')}.csv`);
  try {
    con = await instance.connect();
    await writeFile(path, input.csv, { mode: 0o600 });
    try {
      const columnSpec = input.columns
        .map((c) => `'${c.sql_name.replace(/'/g, "''")}': '${DUCK_TYPES[c.data_type]}'`)
        .join(', ');
      await con.run(
        `CREATE TABLE data AS SELECT * FROM read_csv('${path.replace(/'/g, "''")}', header = true, auto_detect = false, delim = ',', quote = '"', escape = '"', columns = {${columnSpec}})`,
      );
    } finally {
      await unlink(path).catch(() => undefined);
    }
    // Lock down after loading: no file or network access, and no setting can be changed back.
    await con.run('SET enable_external_access = false');
    await con.run('SET lock_configuration = true');
    const opened = con;
    return {
      session: new SandboxSession(opened),
      close: () => {
        opened.closeSync();
        instance.closeSync();
      },
    };
  } catch (err) {
    con?.closeSync();
    instance.closeSync();
    await unlink(path).catch(() => undefined);
    throw err instanceof SandboxError ? err : new SandboxError('failed', 'The data could not be loaded for this question.');
  }
}

/** Runs `fn` with a fresh, locked sandbox over one dataset. Waits for a free slot (max 2), up to 20 s. */
export async function withSandbox<T>(input: SandboxInput, fn: (session: SandboxSession) => Promise<T>): Promise<T> {
  const release = await semaphore.acquire(SANDBOX_LIMITS.maxWaitMs);
  if (!release) {
    throw new AppError('rate_limited', 'The server is busy answering other questions. Please try again in a moment.');
  }
  const started = Date.now();
  try {
    const { session, close } = await openSession(input);
    try {
      return await fn(session);
    } finally {
      close();
    }
  } finally {
    release();
    logger.debug({ ms: Date.now() - started }, 'sandbox closed');
  }
}

/** For tests and diagnostics. */
export const sandboxInUse = () => semaphore.inUse;
