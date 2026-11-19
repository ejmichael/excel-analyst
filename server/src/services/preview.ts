import { parse } from 'csv-parse';
import { Readable } from 'node:stream';
import { AppError } from '../lib/errors.js';
import type { ColumnDataType, DatasetPreview } from '../types/api.js';
import type { SandboxSession } from './sandbox/sandbox.js';

/**
 * The Data tab's rows (GET /datasets/:id/preview with offset, sort, dir and q). Nothing from the request is put into
 * SQL: `sort` must equal one of the dataset's own sql_names and the quoted identifier comes from that column list; the
 * search text is a bound parameter matched with contains() (plain substring, so %, _ and quotes are ordinary
 * characters); offset and limit are validated integers. DuckDB only chooses which rows (their positions in the file);
 * the values come from the normalised CSV with the same typing as the plain preview, so every mode formats alike.
 */

export interface PreviewColumn {
  sql_name: string;
  data_type: ColumnDataType;
}

export interface PreviewParams {
  offset: number;
  limit: number;
  sort?: string;
  dir: 'asc' | 'desc';
  q?: string;
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The column to sort by, from the dataset's own list; anything else is 422 before any query runs. */
export function sortColumn(columns: PreviewColumn[], sort: string | undefined): PreviewColumn | null {
  if (sort === undefined) return null;
  const col = columns.find((c) => c.sql_name === sort);
  if (!col) {
    const message = 'Sort by one of this file’s columns.';
    throw new AppError('validation_failed', message, { fields: [{ location: 'query', path: 'sort', message }] });
  }
  return col;
}

/** Does the request need DuckDB (anything beyond the first rows in file order)? */
export const needsQuery = (p: PreviewParams) => p.offset > 0 || p.sort !== undefined || (p.q ?? '') !== '';

/**
 * Positions (0-based, in file order) of the rows on the requested page, and how many rows match `q`.
 * `sort` must already be resolved by sortColumn.
 */
export async function pageRowPositions(
  session: SandboxSession,
  columns: PreviewColumn[],
  p: PreviewParams,
  totalRows: number,
): Promise<{ positions: number[]; matched: number }> {
  const q = p.q ?? '';
  const params: string[] = [];
  let where = '';
  if (q !== '') {
    const text = columns.filter((c) => c.data_type === 'text');
    if (text.length === 0) return { positions: [], matched: 0 };
    params.push(q.toLowerCase());
    where = `WHERE ${text.map((c) => `contains(lower(${quoteIdent(c.sql_name)}), $1)`).join(' OR ')}`;
  }
  const col = sortColumn(columns, p.sort);
  // rowid is the row's position in the file; it also breaks ties so pages never overlap or skip rows.
  const order = col ? `${quoteIdent(col.sql_name)} ${p.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, rowid` : 'rowid';
  const offset = Math.trunc(p.offset);
  const limit = Math.trunc(p.limit);
  const page = await session.query(`SELECT rowid AS pos FROM data ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, {
    maxRows: limit,
    params,
  });
  const matched =
    q === '' ? totalRows : Number((await session.query(`SELECT count(*) AS n FROM data ${where}`, { maxRows: 1, params })).rows[0]?.n ?? 0);
  return { positions: page.rows.map((r) => Number(r.pos)), matched };
}

export function typed(value: string, type: ColumnDataType): string | number | boolean | null {
  if (value === '') return null;
  if (type === 'integer' || type === 'decimal') return Number(value);
  if (type === 'boolean') return value === 'true';
  return value;
}

/** The rows at `positions` (in that order), read from the normalised CSV. */
export async function rowsAt(file: Buffer, columns: PreviewColumn[], positions: number[]): Promise<DatasetPreview['rows']> {
  if (positions.length === 0) return [];
  const wanted = new Map(positions.map((pos, i) => [pos, i]));
  const last = Math.max(...positions);
  const out: DatasetPreview['rows'] = new Array(positions.length);
  const parser = Readable.from([file]).pipe(parse({ columns: true, relax_column_count: true }));
  let index = 0;
  try {
    for await (const record of parser as AsyncIterable<Record<string, string>>) {
      const slot = wanted.get(index);
      if (slot !== undefined) out[slot] = Object.fromEntries(columns.map((c) => [c.sql_name, typed(record[c.sql_name] ?? '', c.data_type)]));
      if (index >= last) break;
      index++;
    }
  } finally {
    parser.destroy();
  }
  return out.filter((r) => r !== undefined);
}

/** The first `limit` rows in file order (the preview as it always was). */
export async function firstRows(file: Buffer, columns: PreviewColumn[], limit: number): Promise<DatasetPreview['rows']> {
  return rowsAt(file, columns, Array.from({ length: limit }, (_, i) => i));
}
