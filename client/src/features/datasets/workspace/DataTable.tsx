import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { DatasetColumn, DatasetPreview } from '@/api/types';
import { formatRowValue } from '@/lib/format';
import { cn } from '@/lib/utils';

const NUMERIC = new Set(['integer', 'decimal']);

export type SortDir = 'asc' | 'desc';
export interface SortState {
  column: string;
  dir: SortDir;
}

/** The header button cycles: ascending, descending, off. */
export function nextSort(current: SortState | null, column: string): SortState | null {
  if (current?.column !== column) return { column, dir: 'asc' };
  return current.dir === 'asc' ? { column, dir: 'desc' } : null;
}

const SORT_WORDS: Record<SortDir, string> = { asc: 'Sorted ascending', desc: 'Sorted descending' };

interface DataTableProps {
  preview: DatasetPreview;
  columns: DatasetColumn[];
  sort: SortState | null;
  onSort: (column: string) => void;
  /** The rows are the previous page while the next one loads. */
  busy: boolean;
}

/**
 * The file's rows. Scrolls inside its card (sideways and down) with the header row and the first column kept in view.
 * Values are formatted, never changed: the numbers are the server's.
 */
export function DataTable({ preview, columns, sort, onSort, busy }: DataTableProps) {
  const byName = new Map(columns.map((c) => [c.sql_name, c]));

  return (
    <div
      className={cn('max-h-[36rem] overflow-auto rounded-2xl border bg-card transition-opacity', busy && 'opacity-60')}
      tabIndex={0}
      role="region"
      aria-label="Rows of your file (scrolls sideways)"
      aria-busy={busy}
    >
      <table className="w-full border-collapse text-sm tabular">
        <thead>
          <tr>
            {preview.columns.map((c, i) => {
              const column = byName.get(c.sql_name);
              const label = column?.display_name ?? c.label;
              const dir = sort?.column === c.sql_name ? sort.dir : null;
              const Arrow = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown;
              return (
                <th
                  key={c.sql_name}
                  scope="col"
                  aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
                  className={cn(
                    'sticky top-0 z-10 border-b bg-secondary p-0 text-left font-medium whitespace-nowrap',
                    i === 0 && 'left-0 z-20',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSort(c.sql_name)}
                    className={cn(
                      'inline-flex min-h-11 w-full items-center gap-1.5 px-3 py-2 outline-none hover:bg-accent',
                      'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                      NUMERIC.has(c.data_type) && 'justify-end',
                    )}
                  >
                    {label}
                    <Arrow className={cn('size-3.5 shrink-0', dir ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                    {dir && <span className="sr-only">. {SORT_WORDS[dir]}</span>}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, r) => (
            <tr key={r} className="border-b last:border-b-0">
              {preview.columns.map((c, i) => {
                const value = row[c.sql_name] ?? null;
                const text = formatRowValue(value, { money: byName.get(c.sql_name)?.semantic === 'currency_zar' });
                return (
                  <td
                    key={c.sql_name}
                    title={typeof value === 'string' ? value : undefined}
                    className={cn(
                      'max-w-[20rem] truncate px-3 py-2 whitespace-nowrap',
                      NUMERIC.has(c.data_type) && 'text-right',
                      // The first column stays put while the rest scroll sideways.
                      i === 0 && 'sticky left-0 z-[5] bg-card font-medium',
                    )}
                  >
                    {value === null ? <span className="sr-only">empty</span> : text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
