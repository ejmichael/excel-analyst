import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { PublicReportError, getPublicReport, type PublicReportFailure } from '@/api/publicReports';
import type { Block, PublicReport } from '@/api/types';
import { InlineLoading } from '@/components/PageStatus';
import { Button } from '@/components/ui/button';
import { env } from '@/env';
import { formatNumber } from '@/lib/format';
import { AnswerCard } from '@/features/ask/AnswerCard';
import type { DatasetState } from '@/features/ask/HowCalculated';
import { ReportHeader } from '@/features/reports/ReportHeader';
import { documentVars } from '@/features/reports/document';
import { ClosingNote, DownloadPdfButton, RunningFooter } from '@/features/reports/print';

export const UNAVAILABLE_MESSAGE = "This link isn't available. It may have expired or been turned off. Ask the person who sent it for a new link.";

/** A shared report has no file behind it for the visitor: no source rows, no file state. */
const NO_FILE: DatasetState = { exists: false, status: null, expires_at: null, columns: [] };

/** Only for this page: keep it out of search engines, send no referrer, and use the report's title as the tab name. */
function usePublicPageHead(title: string | null) {
  useEffect(() => {
    const previousTitle = document.title;
    const metas = [
      ['robots', 'noindex, nofollow'],
      ['referrer', 'no-referrer'],
    ].map(([name, content]) => {
      const meta = document.createElement('meta');
      meta.name = name!;
      meta.content = content!;
      meta.dataset.publicReport = 'true';
      document.head.appendChild(meta);
      return meta;
    });
    return () => {
      metas.forEach((m) => m.remove());
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    // Never the token or the link: a neutral title.
    document.title = title ?? 'Shared report';
  }, [title]);
}

/**
 * /r/:token: a shared report for anyone with the link. Outside the app: no sign-in, no navigation, no consent gate, no
 * Authorization header and nothing stored. Owner controls are never shown.
 */
export function PublicReportPage() {
  const { token = '' } = useParams();
  const [logoAttempts, setLogoAttempts] = useState(0);
  const query = useQuery({
    queryKey: ['public-report', token],
    queryFn: ({ signal }) => getPublicReport(token, signal),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  usePublicPageHead(query.data?.title ?? null);

  /** The logo is a short-lived URL: on the first failure fetch the report again for a fresh one, then give up quietly. */
  const onLogoError = () => {
    if (logoAttempts === 0) {
      setLogoAttempts(1);
      void query.refetch();
    } else {
      setLogoAttempts(2);
    }
  };

  return (
    // A warm grey desk with the report as a white A4-width sheet on it (white and edge to edge in print).
    <div data-print-shell className="min-h-dvh bg-[#E9E8E1]">
      {query.isPending ? (
        <main className="mx-auto max-w-[210mm] px-4 py-6">
          <InlineLoading label="Loading the report" />
        </main>
      ) : query.isError ? (
        <main className="mx-auto max-w-[210mm] px-4 py-10">
          <Unavailable
            failure={query.error instanceof PublicReportError ? query.error.failure : { kind: 'error' }}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </main>
      ) : (
        <div className="mx-auto max-w-[210mm] pb-10 sm:px-6 sm:pt-6">
          {/* The slim bar: only Download PDF. */}
          <div data-print="hide" className="flex justify-end px-4 py-3 sm:px-0">
            <DownloadPdfButton />
          </div>
          {/* data-doc: the document look on screen (styles/report-doc.css). */}
          <main data-doc className="bg-white px-4 py-6 sm:px-[16mm] sm:py-[18mm] sm:shadow-[0_1px_2px_rgba(22,35,31,0.08),0_8px_28px_rgba(22,35,31,0.10)]">
            <SharedReport report={query.data} onLogoError={onLogoError} logoHidden={logoAttempts >= 2} />
          </main>
        </div>
      )}
    </div>
  );
}

function SharedReport({ report, onLogoError, logoHidden }: { report: PublicReport; onLogoError: () => void; logoHidden: boolean }) {
  return (
    <div className="space-y-6" data-report-root style={documentVars(report.brand)}>
      <RunningFooter title={report.title} businessName={report.brand.business_name} />
      <ReportHeader
        brand={report.brand}
        title={report.title}
        subtitle={report.subtitle}
        periodLabel={report.period_label}
        createdAt={report.created_at}
        notes={report.notes}
        onLogoError={onLogoError}
        logoHidden={logoHidden}
      />

      <ol className="space-y-6" aria-label="Answers in this report" data-report-answers>
        {report.blocks.map((item) => {
          // The public answer has no dataset id; the card treats it as an answer without a file behind it.
          const block: Block = { ...item.block, dataset_id: null };
          return (
            <li key={item.block.id}>
              <AnswerCard block={block} dataset={NO_FILE} mode="public" heading={item.heading_override ?? undefined} documentLook />
            </li>
          );
        })}
      </ol>

      {/* A shared report says nothing about the Excel download: that is the owner's. */}
      <ClosingNote watermark={report.watermark} appName={env.appName} owner={false} />
    </div>
  );
}

function Unavailable({ failure, onRetry, retrying }: { failure: PublicReportFailure; onRetry: () => void; retrying: boolean }) {
  if (failure.kind === 'unavailable') {
    // One page for every case: unknown, expired or turned off. Never says which.
    return (
      <section aria-labelledby="unavailable-heading" className="mx-auto max-w-lg space-y-3 rounded-xl border bg-card p-6">
        <h1 id="unavailable-heading" className="text-2xl font-semibold">
          This link isn't available
        </h1>
        <p>{UNAVAILABLE_MESSAGE}</p>
      </section>
    );
  }
  const message =
    failure.kind === 'rate_limited'
      ? failure.retryAfterSeconds
        ? `This report is being opened a lot right now. Wait ${formatNumber(failure.retryAfterSeconds, 0)} seconds and try again.`
        : 'This report is being opened a lot right now. Wait a moment and try again.'
      : failure.kind === 'network'
        ? 'We could not load this report. Check your connection and try again.'
        : 'Something went wrong while loading this report. Please try again.';
  return (
    <section role="alert" className="mx-auto max-w-lg space-y-3 rounded-xl border bg-card p-6">
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
        <p>{message}</p>
      </div>
      <Button variant="outline" onClick={onRetry} disabled={retrying}>
        {retrying ? 'Trying again…' : 'Try again'}
      </Button>
    </section>
  );
}
