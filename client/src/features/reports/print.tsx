import { useEffect, useId, useState } from 'react';
import { flushSync } from 'react-dom';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/lib/format';

export const PDF_HINT = 'Choose Save as PDF in the print window.';
/**
 * The report brings its own footer (@page margin boxes) and the tab title is the report's title, but whether the
 * browser still adds its own header and footer depends on the browser and its settings, so the user is told.
 */
export const HEADERS_HINT = 'In the print window, turn off Headers and footers.';
export const EXCEL_WORKING_NOTE = 'The working for each figure is in the Excel download.';

/** "Download PDF" opens the browser's print window; the report prints in the document look (styles/print.css). */
export function DownloadPdfButton() {
  const hintId = useId();
  return (
    <span className="inline-flex flex-col gap-1">
      <Button variant="outline" aria-describedby={hintId} onClick={() => window.print()}>
        <Printer aria-hidden />
        Download PDF
      </Button>
      <span id={hintId} className="max-w-[16rem] text-sm text-muted-foreground">
        {PDF_HINT} {HEADERS_HINT}
      </span>
    </span>
  );
}

/**
 * The note after the last answer on a report document. The owner's print adds where the working is (the
 * disclosures are not printed); a shared report does not. "Printed <date>" appears on paper only.
 */
export function ClosingNote({ watermark, appName, owner }: { watermark: boolean; appName: string; owner: boolean }) {
  return (
    <footer data-closing-note>
      <p>Check important figures against your source file.</p>
      {owner && <p>{EXCEL_WORKING_NOTE}</p>}
      <p data-print="only">Printed {formatDate(new Date().toISOString())}.</p>
      {watermark && <p>Made with {appName}</p>}
    </footer>
  );
}

/** A CSS string literal: every character outside a small safe set is a hex escape, so report text cannot break out. */
export function cssString(text: string): string {
  const escaped = [...text]
    .map((ch) => (/^[A-Za-z0-9 ,.]$/.test(ch) ? ch : `\\${ch.codePointAt(0)!.toString(16)} `))
    .join('');
  return `"${escaped}"`;
}

/** The left side of the running footer: "<title>, <business name>", or just the title. */
export function footerText(title: string, businessName: string | null): string {
  return businessName ? `${title}, ${businessName}` : title;
}

/** Puts "<title>, <business name>" at the bottom left of every printed page, next to "Page X of N". */
export function RunningFooter({ title, businessName }: { title: string; businessName: string | null }) {
  useEffect(() => {
    const style = document.createElement('style');
    style.dataset.runningFooter = 'true';
    style.textContent = `@page { @bottom-left { content: ${cssString(footerText(title, businessName))}; font-family: 'Inter Variable', sans-serif; font-size: 8pt; color: #56625c; } }`;
    document.head.appendChild(style);
    return () => style.remove();
  }, [title, businessName]);
  return null;
}

/** The tab (and the browser's print header and saved file name) says the report's title while the page is open. */
export function useDocumentTitle(title: string | null, fallback: string) {
  useEffect(() => {
    const previous = document.title;
    return () => {
      document.title = previous;
    };
  }, []);
  useEffect(() => {
    document.title = title ?? fallback;
  }, [title, fallback]);
}

/**
 * True while the browser prints the page. Charts then switch to the document look (wrapped category labels) before
 * the page is laid out for paper: the switch is rendered synchronously in "beforeprint".
 */
export function usePrinting(): boolean {
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);
  return printing;
}
