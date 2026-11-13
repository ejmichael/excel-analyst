import { useId } from 'react';
import { Check, FilePlus2 } from 'lucide-react';
import type { Block } from '@/api/types';
import { Button } from '@/components/ui/button';
import type { DatasetState } from '@/features/ask/HowCalculated';
import { MAX_REPORT_BLOCKS, useReportTray } from './tray';

export const TRAY_FULL_MESSAGE = `Your report tray holds ${MAX_REPORT_BLOCKS} answers, the most a report can have. Remove one to add this.`;

/** Adds the answer to its workspace's report tray, or takes it out again. */
export function AddToReportButton({ block, dataset }: { block: Block; dataset: DatasetState }) {
  const tray = useReportTray(dataset.workspace_id ?? undefined);
  const reasonId = useId();
  if (!dataset.workspace_id) return null;
  const added = tray.has(block.id);
  const blocked = !added && tray.full;

  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        variant={added ? 'secondary' : 'outline'}
        aria-pressed={added}
        disabled={blocked}
        aria-describedby={blocked ? reasonId : undefined}
        onClick={() =>
          added
            ? tray.remove(block.id)
            : tray.add({ block_id: block.id, title: block.title, dataset_id: block.dataset_id, dataset_name: dataset.name ?? null })
        }
      >
        {added ? <Check aria-hidden /> : <FilePlus2 aria-hidden />}
        {added ? 'Added to report. Remove' : 'Add to report'}
      </Button>
      {blocked && (
        <span id={reasonId} className="max-w-xs text-sm text-muted-foreground">
          {TRAY_FULL_MESSAGE}
        </span>
      )}
    </span>
  );
}
