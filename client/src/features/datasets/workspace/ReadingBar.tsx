import { useId, useState } from 'react';
import { FileCog } from 'lucide-react';
import type { DatasetDetail } from '@/api/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { describeParseOptions } from '../labels';

/**
 * "How we read this file": the sheet or separator, header row, decimals and dates in words, and Change. One line on
 * desktop, two on a phone; the full text is in a title, and More shows it all.
 */
export function ReadingBar({ dataset, onChange }: { dataset: DatasetDetail; onChange: () => void }) {
  const lines = describeParseOptions(dataset.parse_options, dataset.file_type);
  const text = lines.length ? lines.join(' ') : 'We detected the layout ourselves.';
  const [full, setFull] = useState(false);
  const textId = useId();
  return (
    <section aria-labelledby="reading-heading" className="flex max-w-[80ch] items-center gap-2 rounded-2xl border bg-card py-1 pr-1 pl-4 sm:gap-3">
      <FileCog className="size-5 shrink-0 text-primary" aria-hidden />
      <p id={textId} className={cn('my-2 min-w-0 flex-1 text-sm', !full && 'line-clamp-2 sm:line-clamp-none sm:truncate')} title={`How we read this file: ${text}`}>
        <span id="reading-heading" className="font-medium">
          How we read this file:
        </span>{' '}
        <span className="text-muted-foreground">{text}</span>
      </p>
      <Button
        variant="ghost"
        size="sm"
        className="min-h-11 shrink-0 px-2 text-primary"
        aria-expanded={full}
        aria-controls={textId}
        aria-label={full ? 'Less of how we read this file' : 'More of how we read this file'}
        onClick={() => setFull((v) => !v)}
      >
        {full ? 'Less' : 'More'}
      </Button>
      <Button variant="outline" className="shrink-0" aria-label="Change how we read this file" onClick={onChange}>
        Change
      </Button>
    </section>
  );
}
