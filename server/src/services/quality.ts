import type {
  ColumnDataType,
  ColumnSemantic,
  DatasetQuality,
  QualityBand,
  QualityIssue,
  QualityIssueKind,
  QualityPart,
  QualityPartKey,
  QualitySeverity,
} from '../types/api.js';
import type { SandboxSession } from './sandbox/sandbox.js';

/**
 * The data quality score (API_CONTRACT "Data quality"). Deterministic: fixed SQL written here, run in the existing
 * DuckDB sandbox (read-only, memory and time limits) over at most the first QUALITY_ROW_CAP rows. No model call.
 * Column names in the SQL come from the dataset's own column list, quoted; the only bound value is today's date.
 * Nothing here is logged: the caller logs ids, counts and timings only.
 */

export const QUALITY_ROW_CAP = 200_000;

export interface QualityColumn {
  sql_name: string;
  label: string;
  data_type: ColumnDataType;
  semantic: ColumnSemantic;
  is_pii: boolean;
}

const PART_ORDER: QualityPartKey[] = ['missing', 'duplicates', 'types', 'odd_values', 'consistency'];
const WEIGHTS: Record<QualityPartKey, number> = { missing: 30, duplicates: 20, types: 20, odd_values: 15, consistency: 15 };
/** Points lost per 1% affected. */
const PENALTY: Record<QualityPartKey, number> = { missing: 3, duplicates: 3, types: 2, odd_values: 2, consistency: 1 };
const PART_OF: Record<QualityIssueKind, QualityPartKey> = {
  missing_values: 'missing',
  duplicate_rows: 'duplicates',
  mixed_types: 'types',
  extreme_values: 'odd_values',
  impossible_dates: 'odd_values',
  inconsistent_case: 'consistency',
  stray_whitespace: 'consistency',
  mixed_url_scheme: 'consistency',
};
const SEVERITY_RANK: Record<QualitySeverity, number> = { high: 0, medium: 1, low: 2 };
/** Columns where different spellings are expected (people, addresses, free text, contact details). */
const CASE_EXEMPT = new Set<ColumnSemantic>(['email', 'phone', 'sa_id_number', 'person_name', 'address', 'free_text']);

const NUMBER_RE = '[-+]?[0-9]+([ ,.][0-9]+)*';
const DATE_RE = '[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9:.]+)?|[0-9]{1,2}[/.-][0-9]{1,2}[/.-][0-9]{2,4}';

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
/** trim() is a DuckDB macro the sandbox refuses (it serialises as main.trim), so trimming is a regular expression. */
const strip = (expr: string) => `regexp_replace(${expr}, '^\\s+|\\s+$', '', 'g')`;
const hasStraySpace = (expr: string) => `regexp_matches(${expr}, '^\\s|\\s$')`;
const CAPPED = `WITH t AS (SELECT * FROM data WHERE rowid < ${QUALITY_ROW_CAP})`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-ZA')} ${n === 1 ? one : many}`;
const pct = (part: number, whole: number) => (whole === 0 ? 0 : (part / whole) * 100);
const pctText = (part: number, whole: number) => `${Math.round(pct(part, whole))}%`;

export function bandFor(score: number): QualityBand {
  if (score >= 90) return 'very_clean';
  if (score >= 75) return 'good';
  if (score >= 50) return 'needs_attention';
  return 'needs_cleaning';
}

async function rows(session: SandboxSession, sql: string, params: string[] = [], maxRows = 50) {
  return (await session.query(sql, { maxRows, params })).rows;
}
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

function issue(
  kind: QualityIssueKind,
  severity: QualitySeverity,
  column: QualityColumn | null,
  title: string,
  detail: string,
  affected: number,
  examples: string[],
): QualityIssue {
  return {
    id: `${kind}:${column?.sql_name ?? '_'}`,
    kind,
    severity,
    column: column?.sql_name ?? null,
    title,
    detail,
    affected_rows: affected,
    examples: column?.is_pii ? [] : examples.slice(0, 3),
  };
}

/** Today in Africa/Johannesburg plus 366 days, as YYYY-MM-DD: later dates are impossible. */
export function latestPossibleDate(now: Date = new Date()): string {
  const sast = new Date(now.getTime() + 2 * 3_600_000);
  return new Date(Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth(), sast.getUTCDate() + 366)).toISOString().slice(0, 10);
}

export async function computeQuality(
  session: SandboxSession,
  columns: QualityColumn[],
  now: Date = new Date(),
): Promise<Omit<DatasetQuality, 'dataset_id' | 'computed_at'>> {
  const n = Math.min(num((await rows(session, 'SELECT count(*) AS n FROM data'))[0]?.n), QUALITY_ROW_CAP);
  const issues: QualityIssue[] = [];
  const text = columns.filter((c) => c.data_type === 'text');

  // ----- missing_values (one pass over every column) -----
  let emptyCells = 0;
  if (columns.length > 0 && n > 0) {
    const empty = (c: QualityColumn) => (c.data_type === 'text' ? `${q(c.sql_name)} IS NULL OR ${q(c.sql_name)} = ''` : `${q(c.sql_name)} IS NULL`);
    const r = (await rows(session, `${CAPPED} SELECT ${columns.map((c, i) => `count(*) FILTER (WHERE ${empty(c)}) AS m${i}`).join(', ')} FROM t`))[0]!;
    columns.forEach((c, i) => {
      const m = num(r[`m${i}`]);
      emptyCells += m;
      if (m === 0) return;
      const share = m / n;
      const severity: QualitySeverity = m === n || share >= 0.3 ? 'high' : share >= 0.05 ? 'medium' : 'low';
      const detail =
        m === n
          ? `Every row of "${c.label}" is empty, so this column holds no information.`
          : `${plural(m, 'row')} (${pctText(m, n)}) have no value in "${c.label}". Totals and counts over this column leave them out.`;
      issues.push(issue('missing_values', severity, c, `Empty cells in "${c.label}"`, detail, m, []));
    });
  }

  // ----- duplicate_rows -----
  let duplicates = 0;
  if (columns.length > 0 && n > 0) {
    const all = columns.map((c) => q(c.sql_name)).join(', ');
    duplicates = num((await rows(session, `${CAPPED} SELECT coalesce(sum(k - 1), 0) AS d FROM (SELECT count(*) AS k FROM t GROUP BY ${all}) AS g`))[0]?.d);
    if (duplicates > 0) {
      issues.push(
        issue(
          'duplicate_rows',
          duplicates / n >= 0.01 ? 'medium' : 'low',
          null,
          'Rows that appear more than once',
          `${plural(duplicates, 'row is an exact copy', 'rows are exact copies')} of another row. Totals count them twice unless they are real repeat entries.`,
          duplicates,
          [],
        ),
      );
    }
  }

  for (const c of text) {
    const col = q(c.sql_name);
    const v = strip(col);

    // ----- mixed_types: mostly numbers (or dates) with a few that are not -----
    const t = (
      await rows(
        session,
        `${CAPPED} SELECT count(*) FILTER (WHERE ${v} <> '') AS filled,
           count(*) FILTER (WHERE regexp_full_match(${v}, '${NUMBER_RE}')) AS nums,
           count(*) FILTER (WHERE regexp_full_match(${v}, '${DATE_RE}')) AS dates FROM t`,
      )
    )[0]!;
    const filled = num(t.filled);
    for (const [kind, matched] of [['number', num(t.nums)], ['date', num(t.dates)]] as const) {
      if (filled === 0 || matched === filled || matched / filled < 0.9) continue;
      const re = kind === 'number' ? NUMBER_RE : DATE_RE;
      const odd = filled - matched;
      const examples = (
        await rows(session, `${CAPPED} SELECT DISTINCT ${v} AS x FROM t WHERE ${v} <> '' AND NOT regexp_full_match(${v}, '${re}') ORDER BY x LIMIT 3`, [], 3)
      ).map((r) => String(r.x));
      issues.push(
        issue(
          'mixed_types',
          'medium',
          c,
          `Some values in "${c.label}" are not ${kind === 'number' ? 'numbers' : 'dates'}`,
          `"${c.label}" holds ${kind === 'number' ? 'numbers' : 'dates'} in ${pctText(matched, filled)} of its filled rows, but ${plural(odd, 'row does', 'rows do')} not, so the column is read as text and cannot be ${kind === 'number' ? 'added up' : 'used as a date'}.`,
          odd,
          examples,
        ),
      );
      break;
    }

    // ----- stray_whitespace -----
    const ws = num((await rows(session, `${CAPPED} SELECT count(*) AS k FROM t WHERE ${hasStraySpace(col)}`))[0]?.k);
    if (ws > 0) {
      const examples = (await rows(session, `${CAPPED} SELECT DISTINCT ${col} AS x FROM t WHERE ${hasStraySpace(col)} ORDER BY x LIMIT 3`, [], 3)).map((r) => String(r.x));
      issues.push(
        issue(
          'stray_whitespace',
          'low',
          c,
          `Extra spaces in "${c.label}"`,
          `${plural(ws, 'value starts', 'values start')} or ends with a space, so it can look the same as another value but be counted separately.`,
          ws,
          examples,
        ),
      );
    }

    // ----- inconsistent_case -----
    if (!CASE_EXEMPT.has(c.semantic)) {
      const distinct = num((await rows(session, `${CAPPED} SELECT count(DISTINCT ${col}) AS k FROM t`))[0]?.k);
      if (distinct > 0 && distinct <= 200) {
        // Spellings are compared after trimming and collapsing spaces (spaces are stray_whitespace's issue, so a value is
        // not counted twice); what is left differs in capitals. Per value, the most common spelling (ties: first
        // alphabetically) is kept and the rows of the others are affected.
        const spellings = await rows(
          session,
          `${CAPPED}, w AS (SELECT regexp_replace(${v}, '\\s+', ' ', 'g') AS spelling FROM t WHERE ${v} <> ''),
           s AS (SELECT lower(spelling) AS norm, spelling, count(*) AS k FROM w GROUP BY ALL)
           SELECT norm, spelling, k FROM s WHERE norm IN (SELECT norm FROM s GROUP BY norm HAVING count(*) > 1)
           ORDER BY norm, k DESC, spelling`,
          [],
          2000,
        );
        let affected = 0;
        const examples: string[] = [];
        let current: string | null = null;
        for (const r of spellings) {
          if (r.norm !== current) {
            current = String(r.norm);
            if (examples.length < 3) examples.push(String(r.spelling));
            continue; // the majority spelling
          }
          affected += num(r.k);
          if (examples.length < 3) examples.push(String(r.spelling));
        }
        if (affected > 0) {
          issues.push(
            issue(
              'inconsistent_case',
              'low',
              c,
              `The same value written differently in "${c.label}"`,
              `${plural(affected, 'row uses', 'rows use')} different capitals for a value that appears elsewhere, so it is counted as a separate group.`,
              affected,
              examples,
            ),
          );
        }
      }
    }

    // ----- mixed_url_scheme -----
    const u = (
      await rows(
        session,
        `${CAPPED} SELECT count(*) FILTER (WHERE ${v} <> '') AS filled,
           count(*) FILTER (WHERE lower(${v}) LIKE 'http://%') AS http,
           count(*) FILTER (WHERE lower(${v}) LIKE 'https://%') AS https FROM t`,
      )
    )[0]!;
    const http = num(u.http);
    const https = num(u.https);
    if (num(u.filled) > 0 && (http + https) / num(u.filled) >= 0.8 && http > 0 && https > 0) {
      const examples = (await rows(session, `${CAPPED} SELECT DISTINCT ${v} AS x FROM t WHERE lower(${v}) LIKE 'http://%' ORDER BY x LIMIT 3`, [], 3)).map((r) => String(r.x));
      issues.push(
        issue(
          'mixed_url_scheme',
          'medium',
          c,
          `Some links in "${c.label}" are not secure`,
          `${plural(http, 'link uses', 'links use')} http:// while the others use https://. Browsers may warn about the http:// ones.`,
          http,
          examples,
        ),
      );
    }
  }

  // ----- extreme_values -----
  for (const c of columns.filter((x) => x.data_type === 'integer' || x.data_type === 'decimal')) {
    const col = q(c.sql_name);
    const s = (await rows(session, `${CAPPED} SELECT count(${col}) AS k, quantile_cont(${col}, 0.25) AS q1, quantile_cont(${col}, 0.75) AS q3 FROM t`))[0]!;
    if (num(s.k) < 20) continue;
    const q1 = num(s.q1);
    const q3 = num(s.q3);
    const iqr = q3 - q1;
    // User decision 2026-11-19: with no spread between the quartiles (a mostly-zero column such as a discount) there is
    // no usual range to compare with, so the check is skipped.
    if (iqr === 0) continue;
    const outside = `${col} < ${q1 - 3 * iqr} OR ${col} > ${q3 + 3 * iqr}`;
    const k = num((await rows(session, `${CAPPED} SELECT count(*) AS k FROM t WHERE ${outside}`))[0]?.k);
    if (k === 0) continue;
    const examples = (await rows(session, `${CAPPED} SELECT DISTINCT ${col} AS x FROM t WHERE ${outside} ORDER BY x DESC LIMIT 3`, [], 3)).map((r) => String(r.x));
    issues.push(
      issue(
        'extreme_values',
        'low',
        c,
        `Unusually large or small values in "${c.label}"`,
        `${plural(k, 'value is', 'values are')} far outside the usual range of "${c.label}". Check ${k === 1 ? 'it is' : 'they are'} not a typing mistake; ${k === 1 ? 'it' : 'they'} can move totals and averages a lot.`,
        k,
        examples,
      ),
    );
  }

  // ----- impossible_dates -----
  const latest = latestPossibleDate(now);
  for (const c of columns.filter((x) => x.data_type === 'date' || x.data_type === 'datetime')) {
    const col = q(c.sql_name);
    const day = c.data_type === 'datetime' ? `CAST(${col} AS DATE)` : col;
    const outside = `${day} < DATE '1990-01-01' OR ${day} > CAST($1 AS DATE)`;
    const k = num((await rows(session, `${CAPPED} SELECT count(*) AS k FROM t WHERE ${outside}`, [latest]))[0]?.k);
    if (k === 0) continue;
    const examples = (await rows(session, `${CAPPED} SELECT DISTINCT CAST(${col} AS VARCHAR) AS x FROM t WHERE ${outside} ORDER BY x LIMIT 3`, [latest], 3)).map((r) =>
      String(r.x),
    );
    issues.push(
      issue(
        'impossible_dates',
        'medium',
        c,
        `Dates in "${c.label}" that cannot be right`,
        `${plural(k, 'date is', 'dates are')} before 1990 or more than a year in the future, which is usually a typing or format mistake.`,
        k,
        examples,
      ),
    );
  }

  // ----- parts and score -----
  const affectedIn = (part: QualityPartKey) => issues.filter((i) => PART_OF[i.kind] === part).reduce((s, i) => s + i.affected_rows, 0);
  const share: Record<QualityPartKey, number> = {
    missing: pct(emptyCells, n * columns.length),
    duplicates: pct(duplicates, n),
    types: Math.min(100, pct(affectedIn('types'), n)),
    odd_values: Math.min(100, pct(affectedIn('odd_values'), n)),
    consistency: Math.min(100, pct(affectedIn('consistency'), n)),
  };
  const notes: Record<QualityPartKey, (k: number) => string> = {
    missing: (k) => plural(k, 'empty cell'),
    duplicates: (k) => plural(k, 'extra copy', 'extra copies'),
    types: (k) => plural(k, 'value of another type', 'values of another type'),
    odd_values: (k) => plural(k, 'unusual value'),
    consistency: (k) => plural(k, 'value written inconsistently', 'values written inconsistently'),
  };
  const parts: QualityPart[] = PART_ORDER.map((key) => {
    const count = key === 'missing' ? emptyCells : key === 'duplicates' ? duplicates : affectedIn(key);
    return { key, score: Math.max(0, Math.round(100 - PENALTY[key] * share[key])), note: count === 0 ? 'none found' : notes[key](count) };
  });
  const score = Math.round(parts.reduce((s, p) => s + p.score * WEIGHTS[p.key], 0) / 100);

  issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.affected_rows - a.affected_rows || a.id.localeCompare(b.id));
  return { score, band: bandFor(score), parts, issues, rows_checked: n };
}
