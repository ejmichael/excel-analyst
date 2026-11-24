import { useId, useState } from 'react';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import type { DatasetDetail } from '@/api/types';
import { Button } from '@/components/ui/button';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

/** From this many warnings the notice starts open. */
export const OPEN_FROM_WARNINGS = 5;

const storageKey = (datasetId: string) => `analyst:warnings-open:${datasetId}`;

/** The open or closed choice for this file in this tab, or null when none was made (or storage is unavailable). */
export function readNoticeChoice(datasetId: string): boolean | null {
  try {
    const value = window.sessionStorage.getItem(storageKey(datasetId));
    return value === null ? null : value === '1';
  } catch {
    return null;
  }
}

function saveNoticeChoice(datasetId: string, open: boolean): void {
  try {
    window.sessionStorage.setItem(storageKey(datasetId), open ? '1' : '0');
  } catch {
    // Private mode or blocked storage: the choice lasts until the page is left.
  }
}

/** Collapsed unless the file failed to read or has many warnings. */
export const openByDefault = (dataset: Pick<DatasetDetail, 'status' | 'warnings'>) =>
  dataset.status === 'failed' || dataset.warnings.length >= OPEN_FROM_WARNINGS;

/**
 * The file's warnings as a one-line notice ("2 things to check") that expands in place to the list and
 * "Check how we read your file". The choice is remembered per file for the session.
 */
export function WarningsNotice({ dataset, onCheckReading }: { dataset: DatasetDetail; onCheckReading: () => void }) {
  const [open, setOpen] = useState(() => readNoticeChoice(dataset.id) ?? openByDefault(dataset));
  const bodyId = useId();
  const count = dataset.warnings.length;
  const toggle = () => {
    setOpen((was) => {
      saveNoticeChoice(dataset.id, !was);
      return !was;
    });
  };
  return (
    <section aria-labelledby={`${bodyId}-heading`} className="max-w-[80ch] rounded-2xl border border-warning/40 bg-warning-bg" data-warnings-notice>
      <h2 id={`${bodyId}-heading`} className="font-sans text-sm">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
          className="flex min-h-11 w-full items-center gap-2 rounded-2xl px-4 text-left font-semibold focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
          {count === 1 ? '1 thing to check' : `${formatNumber(count, 0)} things to check`}
          <ChevronDown className={cn('ml-auto size-4 shrink-0', open && 'rotate-180')} aria-hidden />
        </button>
      </h2>
      <div id={bodyId} hidden={!open} className="space-y-3 border-t border-warning/30 px-4 pt-3 pb-4">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {dataset.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        <Button variant="outline" className="bg-card" onClick={onCheckReading}>
          Check how we read your file
        </Button>
      </div>
    </section>
  );
}
