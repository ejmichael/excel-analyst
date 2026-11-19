import { FileCog } from 'lucide-react';
import type { DatasetDetail } from '@/api/types';
import { Button } from '@/components/ui/button';
import { describeParseOptions } from '../labels';

/** "How we read this file": the sheet or separator, header row, decimals and dates in words, and Change. */
export function ReadingBar({ dataset, onChange }: { dataset: DatasetDetail; onChange: () => void }) {
  const lines = describeParseOptions(dataset.parse_options, dataset.file_type);
  return (
    <section
      aria-labelledby="reading-heading"
      className="flex flex-col gap-2 rounded-2xl border bg-card px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <FileCog className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <p className="min-w-0 text-sm">
          <span id="reading-heading" className="font-medium">
            How we read this file:
          </span>{' '}
          <span className="text-muted-foreground">{lines.length ? lines.join(' ') : 'We detected the layout ourselves.'}</span>
        </p>
      </div>
      <Button variant="outline" className="self-start sm:self-auto" aria-label="Change how we read this file" onClick={onChange}>
        Change
      </Button>
    </section>
  );
}
