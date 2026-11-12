import type { CellValue, ValueFormat } from '@/api/types';
import { formatValue } from '@/lib/format';
import { cn } from '@/lib/utils';
import { columnLabel } from './chartData';

const RIGHT_ALIGNED = new Set<ValueFormat>(['zar', 'number', 'integer', 'percent']);

interface ResultTableProps {
  columns: Array<{ name: string; format: ValueFormat; label?: string }>;
  rows: Array<Record<string, CellValue>>;
  label: string;
  caption?: string;
}

/** Rows in a table with a sticky header that scrolls sideways inside its own box. Values formatted by column. */
export function ResultTable({ columns, rows, label, caption }: ResultTableProps) {
  return (
    <div className="space-y-2">
      {caption && <p className="text-sm text-muted-foreground tabular">{caption}</p>}
      <div className="max-h-[26rem] overflow-auto rounded-lg border bg-card" tabIndex={0} role="region" aria-label={label}>
        <table className="w-full border-collapse text-sm tabular">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.name}
                  scope="col"
                  className={cn(
                    'sticky top-0 z-10 border-b bg-secondary px-3 py-2 text-left font-medium whitespace-nowrap',
                    RIGHT_ALIGNED.has(c.format) && 'text-right',
                  )}
                >
                  {c.label ?? columnLabel(c.name)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b last:border-b-0">
                {columns.map((c) => (
                  <td key={c.name} className={cn('px-3 py-2 whitespace-nowrap', RIGHT_ALIGNED.has(c.format) && 'text-right')}>
                    {formatValue(row[c.name] ?? null, c.format)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
