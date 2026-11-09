import type { DatasetPreview } from '@/api/types';
import { formatCell, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

const NUMERIC = new Set(['integer', 'decimal']);

/** The first rows of the cleaned file. Scrolls sideways inside its own box; the header stays put. */
export function PreviewTable({ preview }: { preview: DatasetPreview }) {
  const shown = preview.rows.length;
  const caption =
    shown >= preview.total_rows
      ? `Showing all ${formatNumber(preview.total_rows, 0)} rows`
      : `Showing the first ${formatNumber(shown, 0)} of ${formatNumber(preview.total_rows, 0)} rows`;

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground tabular">{caption}</p>
      <div
        className="max-h-[28rem] overflow-auto rounded-xl border bg-card"
        tabIndex={0}
        role="region"
        aria-label="Preview of your file (scrolls sideways)"
      >
        <table className="w-full border-collapse text-sm tabular">
          <thead>
            <tr>
              {preview.columns.map((c) => (
                <th
                  key={c.sql_name}
                  scope="col"
                  className={cn(
                    'sticky top-0 z-10 border-b bg-secondary px-3 py-2 text-left font-medium whitespace-nowrap',
                    NUMERIC.has(c.data_type) && 'text-right',
                  )}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, i) => (
              <tr key={i} className="border-b last:border-b-0">
                {preview.columns.map((c) => (
                  <td
                    key={c.sql_name}
                    className={cn('px-3 py-2 whitespace-nowrap', NUMERIC.has(c.data_type) && 'text-right')}
                  >
                    {formatCell(row[c.sql_name] ?? null, c.data_type)}
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
