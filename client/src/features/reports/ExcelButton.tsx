import { useState } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import { errorMessage, isApiError } from '@/api/client';
import { downloadReportXlsx } from '@/api/reports';
import type { ID } from '@/api/types';
import { FormMessage } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { saveBlob, slugify } from '@/lib/download';
import { formatNumber, isoDateInSast } from '@/lib/format';

/** The server's own message for a report too large to export (500, no contract code fits; see STATUS S4). */
const TOO_LARGE = /too large to export/i;

/** Downloads the report as Excel with the token and saves it under the server's file name. */
export async function downloadReportExcel(report: { id: ID; title: string }): Promise<void> {
  const { blob, filename } = await downloadReportXlsx(report.id);
  // The server names the file (Content-Disposition); <title>-<date>.xlsx only if the header is missing.
  saveBlob(blob, filename ?? `${slugify(report.title)}-${isoDateInSast()}.xlsx`);
}

/** Every failure in words. */
export function describeExcelError(error: unknown): string {
  if (!isApiError(error)) return errorMessage(error);
  switch (error.status) {
    case 402:
      return 'Your plan does not include this download.';
    case 404:
      return 'We could not find this report. It may have been deleted.';
    case 409:
      return 'This report cannot be downloaded right now. Reload the page and try again.';
    case 429:
      return error.retryAfterSeconds
        ? `Other downloads are being prepared. Wait ${formatNumber(error.retryAfterSeconds, 0)} seconds and try again.`
        : 'Other downloads are being prepared. Wait a moment and try again.';
    case 502:
      return 'The Excel file could not be prepared just now. Please try again.';
    default:
      if (error.status === 500 && error.serverMessage && TOO_LARGE.test(error.serverMessage)) return error.serverMessage;
      return errorMessage(error);
  }
}

export function ExcelButton({ report }: { report: { id: ID; title: string } }) {
  const [state, setState] = useState<{ kind: 'idle' | 'busy' | 'done' } | { kind: 'error'; message: string }>({ kind: 'idle' });

  const download = async () => {
    setState({ kind: 'busy' });
    try {
      await downloadReportExcel(report);
      setState({ kind: 'done' });
    } catch (error) {
      // Never left busy: every failure ends here with a message.
      setState({ kind: 'error', message: describeExcelError(error) });
    }
  };

  return (
    <span className="inline-flex flex-col gap-1">
      <Button variant="outline" disabled={state.kind === 'busy'} onClick={() => void download()}>
        <FileSpreadsheet aria-hidden />
        {state.kind === 'busy' ? 'Preparing the Excel file…' : 'Download Excel'}
      </Button>
      <span aria-live="polite" className="max-w-xs">
        {state.kind === 'done' && <span className="text-sm text-muted-foreground">The Excel file has been downloaded.</span>}
        {state.kind === 'error' && <FormMessage>{state.message}</FormMessage>}
      </span>
    </span>
  );
}
