import { useId } from 'react';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';

export const PDF_HINT = 'Choose Save as PDF in the print window.';

/** "Download PDF" opens the browser's print window; the print stylesheet (styles/print.css) prints the report only. */
export function DownloadPdfButton() {
  const hintId = useId();
  return (
    <span className="inline-flex flex-col gap-1">
      <Button variant="outline" aria-describedby={hintId} onClick={() => window.print()}>
        <Printer aria-hidden />
        Download PDF
      </Button>
      <span id={hintId} className="max-w-[16rem] text-sm text-muted-foreground">
        {PDF_HINT}
      </span>
    </span>
  );
}

/** Printed only, after the last answer: what the report is and when it was printed. (The watermark line prints too.) */
export function PrintFooter({ title }: { title: string }) {
  return (
    <footer data-print="only" className="border-t pt-3 text-xs text-muted-foreground">
      {title} · Printed {formatDateTime(new Date().toISOString())}. Check important figures against your source file.
    </footer>
  );
}
