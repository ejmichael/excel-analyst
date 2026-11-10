/**
 * A conservative list of SQL keywords (DuckDB and ANSI) that must not be used as bare column names.
 * A column whose sql_name lands on one of these gets `_col` appended. Over-inclusion is harmless.
 * Also includes `data`, the name of the only table in the sandbox, to avoid confusing queries.
 */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'all', 'alter', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'at', 'attach',
  'between', 'bigint', 'binary', 'bit', 'boolean', 'both', 'by', 'call', 'case', 'cast', 'char', 'character',
  'check', 'collate', 'collation', 'column', 'columns', 'constraint', 'copy', 'create', 'cross', 'cube',
  'current', 'current_catalog', 'current_date', 'current_role', 'current_schema', 'current_time',
  'current_timestamp', 'current_user', 'data', 'database', 'date', 'datetime', 'day', 'days', 'dec', 'decimal',
  'default', 'deferrable', 'delete', 'desc', 'describe', 'detach', 'distinct', 'do', 'double', 'drop', 'else',
  'end', 'enum', 'except', 'exclude', 'exists', 'export', 'extract', 'false', 'fetch', 'filter', 'first', 'float',
  'following', 'for', 'foreign', 'from', 'full', 'function', 'glob', 'grant', 'group', 'grouping', 'having',
  'hour', 'hours', 'ilike', 'import', 'in', 'index', 'initially', 'inner', 'insert', 'install', 'int', 'integer',
  'intersect', 'interval', 'into', 'is', 'isnull', 'join', 'key', 'last', 'lateral', 'leading', 'left', 'like',
  'limit', 'list', 'load', 'localtime', 'localtimestamp', 'map', 'minute', 'minutes', 'month', 'months',
  'natural', 'not', 'notnull', 'null', 'numeric', 'of', 'offset', 'on', 'only', 'or', 'order', 'outer', 'over',
  'overlaps', 'partition', 'pivot', 'pivot_longer', 'pivot_wider', 'placing', 'pragma', 'preceding', 'primary',
  'qualify', 'range', 'real', 'recursive', 'references', 'replace', 'returning', 'right', 'row', 'rows',
  'sample', 'schema', 'second', 'seconds', 'select', 'semi', 'session_user', 'set', 'setof', 'show', 'similar',
  'smallint', 'some', 'struct', 'summarize', 'symmetric', 'table', 'tablesample', 'then', 'time', 'timestamp',
  'to', 'trailing', 'true', 'try_cast', 'union', 'unique', 'unpivot', 'update', 'user', 'using', 'values',
  'varchar', 'variadic', 'verbose', 'view', 'when', 'where', 'window', 'with', 'within', 'year', 'years',
]);
