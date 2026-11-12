import type { ValueFormat } from '../../types/api.js';

/**
 * False-alarm guard for the reconcile check (ARCHITECTURE 3 step 4). The check adds up the breakdown column over all
 * result rows, which is only meaningful when that column is a plain SUM or COUNT over disjoint groups that together
 * cover the rows total_sql counts. This walks DuckDB's parse tree (json_serialize_sql) of the main SQL, finds where the
 * reconcile column comes from, and returns why the planned reconcile must be discarded, or null when it is valid.
 * The reason is a fixed category, safe to log (never SQL or values).
 */
export type ReconcileSkipReason =
  | 'percent_column'
  | 'count_distinct'
  | 'distinct_aggregate'
  | 'non_additive_aggregate'
  | 'derived_value'
  | 'window_function'
  | 'overlapping_groups'
  | 'filtered_groups'
  | 'limited_result'
  | 'unresolved_column'
  | 'not_simple_select';

type Node = Record<string, unknown>;
type Expr = Record<string, unknown>;

/** Aggregates whose per-group values add up to the value over all rows. */
const ADDITIVE = new Set(['sum', 'count', 'count_star', 'fsum', 'sumkahan', 'kahan_sum', 'sum_no_overflow']);
/** Wrappers that keep an additive value additive (ROUND(SUM(x), 2) is how the planner returns money). */
const PASS_THROUGH = new Set(['round']);

const MAX_DEPTH = 8;

const lower = (v: unknown) => String(v ?? '').toLowerCase();
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function limitOf(node: Node): { limited: boolean; limit: number | null } {
  const modifiers = Array.isArray(node.modifiers) ? (node.modifiers as Node[]) : [];
  for (const m of modifiers) {
    if (m.type !== 'LIMIT_MODIFIER' && m.type !== 'LIMIT_PERCENT_MODIFIER') continue;
    if (m.offset) return { limited: true, limit: null };
    const limit = isObj(m.limit) && isObj(m.limit.value) ? Number(m.limit.value.value) : NaN;
    if (m.type === 'LIMIT_MODIFIER' && m.limit && Number.isFinite(limit)) return { limited: true, limit };
    if (m.limit || m.limit === undefined) return { limited: true, limit: null };
  }
  return { limited: false, limit: null };
}

function hasDistinctModifier(node: Node): boolean {
  return Array.isArray(node.modifiers) && (node.modifiers as Node[]).some((m) => m.type === 'DISTINCT_MODIFIER');
}

function ctesOf(node: Node, outer: Map<string, Node>): Map<string, Node> {
  const ctes = new Map(outer);
  const map = isObj(node.cte_map) && Array.isArray(node.cte_map.map) ? (node.cte_map.map as Node[]) : [];
  for (const entry of map) {
    const value = isObj(entry.value) ? entry.value : null;
    const query = value && isObj(value.query) && isObj(value.query.node) ? value.query.node : null;
    if (query) ctes.set(lower(entry.key), query);
  }
  return ctes;
}

/** The select-list expression that produces result column `column` (by alias, or by a bare column reference). */
function findOutput(node: Node, column: string): Expr | 'star' | null {
  const list = Array.isArray(node.select_list) ? (node.select_list as Expr[]) : [];
  const want = column.toLowerCase();
  for (const e of list) if (lower(e.alias) === want) return e;
  for (const e of list) {
    if (e.alias) continue;
    if (e.class === 'COLUMN_REF' && Array.isArray(e.column_names) && lower(e.column_names.at(-1)) === want) return e;
  }
  return list.some((e) => e.class === 'STAR') ? 'star' : null;
}

const isGrouped = (node: Node) => Array.isArray(node.group_expressions) && node.group_expressions.length > 0;

function classifyNode(node: Node, column: string, outerCtes: Map<string, Node>, root: boolean, rowCount: number, depth: number): ReconcileSkipReason | null {
  if (depth > MAX_DEPTH || node.type !== 'SELECT_NODE') return 'not_simple_select';
  const ctes = ctesOf(node, outerCtes);
  const { limited, limit } = limitOf(node);
  // A LIMIT that may have cut groups off: at the top level only when the result filled it; deeper, always.
  if (limited && (!root || limit === null || rowCount >= limit)) return 'limited_result';
  if (hasDistinctModifier(node)) return 'distinct_aggregate';
  if (Array.isArray(node.group_sets) && node.group_sets.length > 1) return 'overlapping_groups';
  const out = findOutput(node, column);
  if (out === null || out === 'star') return 'unresolved_column';
  const reason = classifyExpr(out, node, ctes, rowCount, depth);
  if (reason) return reason;
  // Groups dropped by HAVING or QUALIFY no longer cover what total_sql counts.
  if (node.having || node.qualify) return 'filtered_groups';
  return null;
}

function classifyExpr(e: Expr, node: Node, ctes: Map<string, Node>, rowCount: number, depth: number): ReconcileSkipReason | null {
  if (e.class === 'WINDOW') return 'window_function';
  if (e.class === 'CAST') return isObj(e.child) ? classifyExpr(e.child, node, ctes, rowCount, depth) : 'derived_value';
  if (e.type === 'OPERATOR_COALESCE') {
    const [first, ...rest] = Array.isArray(e.children) ? (e.children as Expr[]) : [];
    if (!first || rest.some((c) => c.class !== 'CONSTANT')) return 'derived_value';
    return classifyExpr(first, node, ctes, rowCount, depth);
  }
  if (e.class === 'FUNCTION') {
    const name = lower(e.function_name);
    const children = Array.isArray(e.children) ? (e.children as Expr[]) : [];
    if (ADDITIVE.has(name)) {
      if (e.distinct) return name === 'count' ? 'count_distinct' : 'distinct_aggregate';
      // The aggregate's own input must not be a window or a nested aggregate.
      return children.some((c) => c.class === 'WINDOW') ? 'window_function' : null;
    }
    if (PASS_THROUGH.has(name) && children[0]) return classifyExpr(children[0], node, ctes, rowCount, depth);
    if (name === 'approx_count_distinct') return 'count_distinct';
    if (e.distinct) return 'distinct_aggregate';
    if (e.is_operator || /^[-+*/%]$|^\/\/$/.test(name)) return 'derived_value';
    if (NON_ADDITIVE.test(name)) return 'non_additive_aggregate';
    return 'derived_value';
  }
  if (e.class === 'COLUMN_REF') {
    // A column of a grouped SELECT that is not an aggregate is a group key, not something to add up.
    if (isGrouped(node)) return 'derived_value';
    const name = Array.isArray(e.column_names) ? String(e.column_names.at(-1)) : '';
    const from = isObj(node.from_table) ? node.from_table : null;
    if (!from) return 'unresolved_column';
    // An outer WHERE over an already-grouped CTE or subquery drops whole groups.
    const filtersGroups = Boolean(node.where_clause);
    if (from.type === 'SUBQUERY') {
      const sub = isObj(from.subquery) && isObj(from.subquery.node) ? from.subquery.node : null;
      if (!sub) return 'not_simple_select';
      const inner = classifyNode(sub, name, ctes, false, rowCount, depth + 1);
      return inner ?? (filtersGroups && isGrouped(sub) ? 'filtered_groups' : null);
    }
    if (from.type === 'BASE_TABLE') {
      const cte = ctes.get(lower(from.table_name));
      if (cte) {
        const inner = classifyNode(cte, name, ctes, false, rowCount, depth + 1);
        return inner ?? (filtersGroups && isGrouped(cte) ? 'filtered_groups' : null);
      }
      // A raw column of data, one result row per table row: each row is its own disjoint group.
      return null;
    }
    return 'not_simple_select'; // joins and table functions
  }
  return 'derived_value'; // constants, CASE, arithmetic operators and anything else
}

const NON_ADDITIVE =
  /^(avg|mean|favg|min|max|median|mode|stddev|stddev_pop|stddev_samp|var_pop|var_samp|variance|quantile|quantile_cont|quantile_disc|percentile_cont|percentile_disc|approx_quantile|mad|kurtosis|skewness|entropy|product|arg_max|arg_min|argmax|argmin|max_by|min_by|first|last|any_value|arbitrary|bit_and|bit_or|bit_xor|bool_and|bool_or|corr|covar_pop|covar_samp|regr_\w+|geomean|geometric_mean|histogram|list|array_agg|string_agg|group_concat|listagg)$/;

export interface GuardInput {
  /** json_serialize_sql output for the main SQL. */
  tree: unknown;
  column: string;
  valueFormat: Record<string, ValueFormat>;
  /** The true number of result rows (to tell whether a top-level LIMIT cut groups off). */
  rowCount: number;
}

export function reconcileSkipReason({ tree, column, valueFormat, rowCount }: GuardInput): ReconcileSkipReason | null {
  if (valueFormat[column] === 'percent') return 'percent_column';
  const statements = isObj(tree) && Array.isArray(tree.statements) ? (tree.statements as Node[]) : [];
  const root = statements.length === 1 && isObj(statements[0]!.node) ? (statements[0]!.node as Node) : null;
  if (!root) return 'not_simple_select';
  return classifyNode(root, column, new Map(), true, rowCount, 0);
}
