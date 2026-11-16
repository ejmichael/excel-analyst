import { Link } from 'react-router';
import { Info, MessageSquarePlus, Pencil, X } from 'lucide-react';
import type { ID, ReportDetail } from '@/api/types';
import { Button } from '@/components/ui/button';
import { formatNumber } from '@/lib/format';

/** Reports whose draft notice was dismissed, so it is not shown again. localStorage, or memory if unavailable. */
const KEY_PREFIX = 'analyst.draft-dismissed.';
const dismissedInMemory = new Set<ID>();

export const draftDismissals = {
  has(reportId: ID): boolean {
    if (dismissedInMemory.has(reportId)) return true;
    try {
      return window.localStorage.getItem(KEY_PREFIX + reportId) === '1';
    } catch {
      return false;
    }
  },
  add(reportId: ID): void {
    dismissedInMemory.add(reportId);
    try {
      window.localStorage.setItem(KEY_PREFIX + reportId, '1');
    } catch {
      // Not fatal: remembered for this tab.
    }
  },
  /** For tests. */
  resetMemory(): void {
    dismissedInMemory.clear();
  },
};

/** The draft's summary in words, counted from the answers' own statuses (no figures are computed). */
export function draftSummary(report: ReportDetail): string {
  const total = report.blocks.length;
  const flagged = report.blocks.filter((b) => b.block.status === 'flagged').length;
  if (flagged === 0) return 'All checks passed on every answer.';
  const answers = `${formatNumber(total, 0)} ${total === 1 ? 'answer' : 'answers'}`;
  return `${answers}, ${formatNumber(flagged, 0)} of them ${flagged === 1 ? 'needs' : 'need'} a closer look. Answers marked “Check the numbers” failed a check.`;
}

interface DraftBannerProps {
  report: ReportDetail;
  onEdit: () => void;
  onDismiss: () => void;
}

/** Shown on a report made by "Build my report" (?draft=1) until dismissed. Never says the report is final. */
export function DraftBanner({ report, onEdit, onDismiss }: DraftBannerProps) {
  // Asking a new question happens on the file's Ask page; the answer can then be added with Edit report.
  const datasetId = report.blocks.find((b) => b.block.dataset_id !== null)?.block.dataset_id ?? null;
  return (
    <section aria-labelledby="draft-banner-heading" data-print="hide" className="rounded-xl border border-primary/40 bg-accent p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <Info className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <h2 id="draft-banner-heading" className="font-semibold">
            This is a draft. Check it before you send it.
          </h2>
          <p>{draftSummary(report)}</p>
          <div className="flex flex-wrap gap-2 pt-1">
            {datasetId && (
              <Button asChild variant="outline" className="bg-card">
                <Link to={`/datasets/${datasetId}/ask`}>
                  <MessageSquarePlus aria-hidden />
                  Add your own question
                </Link>
              </Button>
            )}
            <Button variant="outline" className="bg-card" onClick={onEdit}>
              <Pencil aria-hidden />
              Edit report
            </Button>
          </div>
          {datasetId && (
            <p className="text-sm text-muted-foreground">
              Ask on the file's page, then come back and choose Edit report, then Add answers, to put it in this report.
            </p>
          )}
        </div>
        <Button variant="ghost" size="icon" aria-label="Dismiss the draft notice" onClick={onDismiss}>
          <X aria-hidden />
        </Button>
      </div>
    </section>
  );
}
