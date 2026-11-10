/**
 * SQL validation for the sandbox (ARCHITECTURE section 4), in two layers:
 * 1. A lexical scan of the SQL with string literals and quoted identifiers blanked out: no comments, no semicolons,
 *    no dollar-quoting, and none of the denied keywords. A quoted column such as "Update" passes; UPDATE does not.
 * 2. DuckDB's own parser (json_serialize_sql, which only serialises SELECT statements): exactly one statement, and a
 *    walk of the whole tree: tables must be `data` or a CTE, no table functions, no denied or schema-qualified functions.
 * Every query the server runs on user data goes through both layers.
 */

export class SqlRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SqlRejected';
  }
}

export const MAX_SQL_LENGTH = 8000;

/** ARCHITECTURE 4's list, plus a few more file and SQL-executing table functions. Matched as whole words. */
const DENIED_WORDS = [
  'read_csv', 'read_csv_auto', 'read_parquet', 'read_json', 'read_json_auto', 'read_json_objects', 'read_ndjson',
  'read_ndjson_auto', 'read_ndjson_objects', 'read_text', 'read_blob', 'parquet_scan', 'sniff_csv', 'glob', 'copy',
  'attach', 'detach', 'install', 'load', 'pragma', 'set', 'reset', 'export', 'import', 'call', 'create', 'drop',
  'alter', 'insert', 'update', 'delete', 'information_schema', 'getenv', 'current_setting', 'query', 'query_table',
  'checkpoint', 'vacuum',
];
const DENIED_PREFIXES = ['duckdb_', 'pg_', 'sqlite_', 'pragma_'];
const DENIED_WORD_RE = new RegExp(`\\b(${DENIED_WORDS.join('|')})\\b`, 'i');
const DENIED_PREFIX_RE = new RegExp(`\\b(${DENIED_PREFIXES.join('|')})\\w*`, 'i');

/** Functions rejected wherever they appear in the parsed tree (file, system, settings, extension and SQL-running functions). */
const DENIED_FUNCTIONS = new Set([
  ...DENIED_WORDS,
  'read_xlsx', 'parquet_metadata', 'parquet_schema', 'parquet_file_metadata', 'parquet_kv_metadata', 'set_variable',
  'getvariable', 'which_secret', 'load_extension', 'iceberg_scan', 'delta_scan', 'sql_auto_complete', 'json_execute_serialized_sql',
  'current_database', 'current_schema', 'current_schemas', 'current_catalog', 'current_user', 'user', 'session_user', 'version',
]);

/**
 * Blanks out '…' string literals and "…" quoted identifiers (keeping the quotes), so keyword checks only see SQL.
 * Rejects comments, semicolons and dollar-quoting outside literals.
 */
export function stripLiterals(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new SqlRejected('A quote is never closed.');
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2; // doubled quote inside the literal
            continue;
          }
          break;
        }
        j++;
      }
      out += ch + ' '.repeat(j - i - 1) + ch;
      i = j + 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') throw new SqlRejected('Comments are not allowed.');
    if (ch === '/' && sql[i + 1] === '*') throw new SqlRejected('Comments are not allowed.');
    if (ch === ';') throw new SqlRejected('Only one statement is allowed.');
    // `$1` parameters are fine; anything else with `$` (dollar-quoted strings) is not.
    if (ch === '$' && !/\d/.test(sql[i + 1] ?? '')) throw new SqlRejected('Dollar-quoted strings are not allowed.');
    out += ch;
    i++;
  }
  return out;
}

/** Layer 1: the lexical scan. */
export function scanSql(sql: string): void {
  if (sql.trim() === '') throw new SqlRejected('The query is empty.');
  if (sql.length > MAX_SQL_LENGTH) throw new SqlRejected('The query is too long.');
  const bare = stripLiterals(sql);
  const word = DENIED_WORD_RE.exec(bare);
  if (word) throw new SqlRejected(`The query uses "${word[1]!.toUpperCase()}", which is not allowed.`);
  const prefix = DENIED_PREFIX_RE.exec(bare);
  if (prefix) throw new SqlRejected('The query uses a system table or function, which is not allowed.');
}

type Node = Record<string, unknown>;

function cteNames(node: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => cteNames(n, out));
  else if (node && typeof node === 'object') {
    const n = node as Node;
    const map = (n.cte_map as { map?: Array<{ key?: string }> } | undefined)?.map;
    if (Array.isArray(map)) for (const entry of map) if (entry.key) out.add(entry.key.toLowerCase());
    Object.values(n).forEach((v) => cteNames(v, out));
  }
  return out;
}

/** Layer 2: walks DuckDB's parse tree (json_serialize_sql output). Throws SqlRejected on anything not allowed. */
export function checkParseTree(parsed: unknown): void {
  const p = parsed as { error?: boolean; error_message?: string; statements?: unknown[] };
  if (!p || p.error) {
    // DuckDB's parser message (no data in it): passed to the repair call as-is.
    throw new SqlRejected(p?.error_message ? `The query could not be parsed: ${p.error_message}` : 'The query could not be parsed.');
  }
  if (!Array.isArray(p.statements) || p.statements.length !== 1) throw new SqlRejected('Only one statement is allowed.');
  const ctes = cteNames(p.statements, new Set());

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const n = node as Node;
    const type = n.type;
    if (type === 'TABLE_FUNCTION') throw new SqlRejected('Table functions are not allowed; query the table data.');
    if (type === 'BASE_TABLE') {
      const table = String(n.table_name ?? '').toLowerCase();
      const qualified = Boolean(n.schema_name) || Boolean(n.catalog_name);
      if (qualified || (table !== 'data' && !ctes.has(table))) {
        throw new SqlRejected('The only table available is data.');
      }
    }
    if (n.class === 'FUNCTION' || type === 'FUNCTION') {
      const name = String(n.function_name ?? '').toLowerCase();
      if (n.schema || n.catalog || n.schema_name || n.catalog_name) throw new SqlRejected('Qualified function names are not allowed.');
      if (DENIED_FUNCTIONS.has(name) || DENIED_PREFIXES.some((pre) => name.startsWith(pre))) {
        throw new SqlRejected(`The function ${name} is not allowed.`);
      }
    }
    Object.values(n).forEach(walk);
  };
  walk(p.statements);
}
