import { Link } from 'react-router';
import { FileText } from 'lucide-react';
import type { DatasetDetail } from '@/api/types';
import { BuildReportSection, MIN_SUGGESTIONS } from '@/features/autoReport/BuildReportSection';

/** The Reports tab: "Build my report" and its progress, and the way to every report. */
export function ReportsTab({ dataset }: { dataset: DatasetDetail }) {
  const canBuild = dataset.status === 'ready' && dataset.suggestions.length >= MIN_SUGGESTIONS;
  return (
    <div className="space-y-6">
      <BuildReportSection dataset={dataset} />
      {!canBuild && dataset.status === 'ready' && (
        <p className="rounded-2xl border bg-card p-5">
          Build my report needs at least {MIN_SUGGESTIONS} suggested questions, and this file has fewer. You can still ask
          your own questions on the Ask tab and pin the answers to a report.
        </p>
      )}
      <section aria-labelledby="all-reports-heading" className="space-y-2 rounded-2xl border bg-card p-5">
        <h2 id="all-reports-heading" className="text-lg font-semibold">
          Your reports
        </h2>
        <p className="text-muted-foreground">Every report in this workspace is on the Reports page.</p>
        <Link to="/reports" className="inline-flex min-h-11 items-center gap-2 font-medium text-primary underline underline-offset-4">
          <FileText className="size-4" aria-hidden />
          Open the Reports page
        </Link>
      </section>
    </div>
  );
}
