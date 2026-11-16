import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';

/** Hand-computed truth from the RAW fixture files: plain JavaScript loops, not DuckDB, not the Part 2 parser, not the model. */

const FIX = new URL('../../../fixtures/', import.meta.url);
const raw = (name: string) => readFileSync(new URL(name, FIX));

/** "1 234,56" / "-1 578,28" -> number, by hand. */
export const commaAmount = (s: string) => Number(s.replace(/\s/g, '').replace(',', '.'));
/** "1,234.56" -> number. */
export const dotAmount = (s: string) => Number(s.replace(/,/g, ''));
export const round2 = (n: number) => Math.round(n * 100) / 100;

export function cardSales() {
  const text = new TextDecoder('windows-1252').decode(raw('01_card_sales_semicolon_win1252.csv'));
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines.findIndex((l) => l.startsWith('Transaction Date;'));
  const rows: Array<{ date: string; store: string; card: string; gross: number; net: number }> = [];
  for (const line of lines.slice(header + 1)) {
    const f = line.split(';');
    if (f[0] === 'Total') continue;
    const [d, m, y] = f[0]!.split('/');
    rows.push({ date: `${y}-${m}-${d}`, store: f[3]!, card: f[4]!, gross: commaAmount(f[6]!), net: commaAmount(f[8]!) });
  }
  return rows;
}

export function webOrders() {
  const records = parse(raw('02_webstore_orders_utf8bom.csv'), { bom: true, columns: true }) as Array<Record<string, string>>;
  return records.map((r) => ({
    date: r['Created at']!.slice(0, 10),
    product: r.Product!,
    quantity: Number(r.Quantity),
    total: Number(r.Total),
    status: r['Payment status']!,
    province: r.Province!,
    customer: r['Customer email']!,
  }));
}

export function bankStatement() {
  const records = parse(raw('03_bank_statement_comma_quoted.csv'), { relax_column_count: true, from_line: 3 }) as string[][];
  const rows: Array<{ date: string; description: string; amount: number; balance: number }> = [];
  for (const f of records.slice(1)) {
    if (f[0] === 'Total' || !f[0]) continue;
    const [d, m, y] = f[0].split('/');
    rows.push({ date: `${y}-${m}-${d}`, description: f[1]!, amount: dotAmount(f[2]!), balance: dotAmount(f[3]!) });
  }
  return rows;
}

export const sumBy = <T>(rows: T[], key: (r: T) => string, value: (r: T) => number) => {
  const out = new Map<string, number>();
  for (const r of rows) out.set(key(r), (out.get(key(r)) ?? 0) + value(r));
  return new Map([...out].map(([k, v]) => [k, round2(v)]));
};
