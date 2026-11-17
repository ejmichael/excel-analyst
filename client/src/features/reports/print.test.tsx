import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClosingNote, DownloadPdfButton, EXCEL_WORKING_NOTE, HEADERS_HINT, PDF_HINT, RunningFooter, cssString, footerText } from './print';

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const printCss = strip(readFileSync(resolve(__dirname, '../../styles/print.css'), 'utf8'));
const docCss = strip(readFileSync(resolve(__dirname, '../../styles/report-doc.css'), 'utf8'));
const indexCss = readFileSync(resolve(__dirname, '../../index.css'), 'utf8');
/** The body of the @media print block of print.css. */
const printBlock = printCss.slice(printCss.indexOf('@media print'));

/** The declarations of the first rule whose selector list contains `selector` (in print.css's print block). */
function printRule(selector: string): string {
  const at = printBlock.indexOf(selector);
  expect(at, `print rule for ${selector}`).toBeGreaterThan(-1);
  return printBlock.slice(printBlock.indexOf('{', at), printBlock.indexOf('}', at));
}

/** The declarations of every document-look rule for `selector` (report-doc.css: `selector { @variant doc { ... } }`). */
function docRule(selector: string): string {
  const head = `${selector} {\n  @variant doc {`;
  const bodies: string[] = [];
  for (let at = docCss.indexOf(head); at > -1; at = docCss.indexOf(head, at + 1)) {
    const body = docCss.indexOf('@variant doc {', at);
    bodies.push(docCss.slice(body, docCss.indexOf('}', body)));
  }
  expect(bodies.length, `document rule for ${selector}`).toBeGreaterThan(0);
  return bodies.join('\n');
}

afterEach(() => vi.restoreAllMocks());

describe('Download PDF', () => {
  it('opens the print window, says how to save a PDF and to turn off the browser’s headers and footers', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<DownloadPdfButton />);
    const button = screen.getByRole('button', { name: 'Download PDF' });
    expect(button).toHaveAccessibleDescription(`${PDF_HINT} ${HEADERS_HINT}`);
    await userEvent.click(button);
    expect(print).toHaveBeenCalledTimes(1);
  });
});

describe('the document look applies in print and on the shared page only', () => {
  it('the doc variant is print, or on screen inside [data-doc]; both stylesheets are loaded', () => {
    expect(indexCss).toMatch(/@import '\.\/styles\/print\.css'/);
    expect(indexCss).toMatch(/@import '\.\/styles\/report-doc\.css'/);
    expect(indexCss).toMatch(/@custom-variant doc {\s*@media print {\s*@slot;\s*}\s*&:where\(\[data-doc\], \[data-doc\] \*\) {\s*@slot;/);
  });

  it('answers are not cards: no border, radius, background or padding', () => {
    const answer = docRule('[data-print-answer]');
    for (const declaration of [/border:\s*0/, /border-radius:\s*0/, /background:\s*transparent/, /padding:\s*0/]) expect(answer).toMatch(declaration);
    expect(docRule('[data-report-header]')).toMatch(/border:\s*0/);
    expect(docRule('[data-kpi]')).toMatch(/border:\s*0/);
  });

  it('the masthead is a 3.2mm brand rule over an identity line; no text sits on the brand colour', () => {
    const band = docRule('[data-report-header] [data-brand-band]');
    expect(band).toMatch(/border-top:\s*3\.2mm solid var\(--brand\)/);
    expect(band).toMatch(/background:\s*transparent !important/);
    expect(band).toMatch(/color:\s*#16231f !important/);
    expect(docRule('[data-brand-band] img')).toMatch(/max-height:\s*12mm/);
  });

  it('per-answer timestamps are left out', () => {
    expect(docRule('[data-answer-time]')).toMatch(/display:\s*none/);
  });

  it('marks use the guarded brand colour; the table header uses the tint with an ink rule', () => {
    // Series colours come from documentVars: the brand mark first, then clearly different ones.
    expect(docRule('[data-report-root]')).toMatch(/--series-1:\s*var\(--doc-series-1\)/);
    expect(docRule('[data-check-line] svg')).toMatch(/color:\s*var\(--brand-mark\)/);
    const th = docRule('[data-print-table] th');
    expect(th).toMatch(/background:\s*var\(--brand-tint\)/);
    expect(th).toMatch(/border-bottom:\s*0\.75pt solid #16231f/);
  });

  it('a failed check stays in words: amber rule, dark amber text on light amber', () => {
    const note = docRule('[data-flagged-note]');
    expect(note).toMatch(/border-left:\s*1\.2mm solid/);
    expect(note).toMatch(/background:\s*#fff4d6/);
    expect(note).toMatch(/color:\s*#7a4f00/);
  });
});

describe('the print stylesheet', () => {
  it('prints on A4 portrait with 18/16/20 mm margins and "Page X of N" at the bottom right', () => {
    expect(printCss).toMatch(/@page\s*{[^}]*size:\s*A4 portrait/);
    expect(printCss).toMatch(/margin:\s*18mm 16mm 20mm/);
    expect(printCss).toMatch(/@bottom-right\s*{\s*content:\s*'Page ' counter\(page\) ' of ' counter\(pages\)/);
  });

  it('leaves out the app chrome, buttons, dialogs and the working (disclosures, SQL, source rows)', () => {
    const hidden = printRule("[data-print='hide'],");
    expect(hidden).toMatch(/display:\s*none !important/);
    for (const selector of ['nav,', 'aside,', 'button,', "[role='dialog'],", '[data-answer-working]']) expect(printBlock).toContain(selector);
  });

  it('keeps headings, questions and the narrative with what follows; the narrative never splits', () => {
    const meta = printRule('[data-answer-meta],');
    expect(meta).toMatch(/break-after:\s*avoid/);
    expect(printBlock).toMatch(/\[data-answer-meta\] h2,\s*\[data-answer-meta\] h3,\s*\[data-answer-question\] {\s*break-after:\s*avoid/);
    expect(printRule('[data-answer-narrative],')).toMatch(/break-inside:\s*avoid;\s*break-after:\s*avoid/);
  });

  it('never splits a chart answer, and has no keep-together rule for a table answer', () => {
    expect(printBlock).toMatch(/\[data-print-answer\]\[data-answer-kind='chart'\] {\s*break-inside:\s*avoid/);
    expect(printBlock).not.toMatch(/data-answer-kind='table'/);
    // No rule keeps every answer together regardless of its kind.
    expect(printBlock).not.toMatch(/\[data-print-answer\] {\s*break-inside:\s*avoid/);
  });

  it('a table breaks only between rows, with its header row repeated and at least three rows on each side', () => {
    expect(printRule('[data-print-table] thead')).toMatch(/display:\s*table-header-group/);
    expect(printRule('[data-print-table] tr {')).toMatch(/break-inside:\s*avoid/);
    expect(printBlock).toMatch(/tbody tr:nth-child\(-n \+ 3\),\s*\[data-print-table\] tbody tr:nth-last-child\(-n \+ 2\) {\s*break-before:\s*avoid/);
    expect(printRule('[data-print-table] {')).toMatch(/max-height:\s*none !important;\s*overflow:\s*visible !important/);
    expect(printRule('[data-print-table] td[data-numeric]')).toMatch(/white-space:\s*nowrap !important/);
  });

  it('the check line never starts a page, and the closing note never stands alone', () => {
    expect(printRule('[data-check-line] {')).toMatch(/break-before:\s*avoid/);
    expect(printRule('[data-closing-note] {')).toMatch(/break-inside:\s*avoid;\s*break-before:\s*avoid/);
  });
});

describe('the closing note', () => {
  it('the owner’s note says where the working is; a shared report’s does not', () => {
    const { container, rerender } = render(<ClosingNote watermark={false} appName="Analyst" owner />);
    expect(container).toHaveTextContent('Check important figures against your source file.');
    expect(container).toHaveTextContent(EXCEL_WORKING_NOTE);
    expect(screen.getByText(/^Printed \d{1,2} \w+ \d{4}\.$/)).toHaveAttribute('data-print', 'only');
    rerender(<ClosingNote watermark={false} appName="Analyst" owner={false} />);
    expect(container).not.toHaveTextContent(EXCEL_WORKING_NOTE);
  });

  it('has the watermark line only when watermark is true', () => {
    const { container, rerender } = render(<ClosingNote watermark appName="Analyst" owner={false} />);
    expect(container).toHaveTextContent('Made with Analyst');
    rerender(<ClosingNote watermark={false} appName="Analyst" owner={false} />);
    expect(container).not.toHaveTextContent('Made with');
  });
});

describe('the running footer', () => {
  it('is "<title>, <business name>", or just the title', () => {
    expect(footerText('October review', 'Mokoena Bakery')).toBe('October review, Mokoena Bakery');
    expect(footerText('October review', null)).toBe('October review');
  });

  it('puts it at the bottom left of every page, escaped so report text cannot break out of the CSS string', () => {
    const { unmount } = render(<RunningFooter title={'Q3 "final" \\ report\n</style><script>x</script>'} businessName="Café & Co" />);
    const style = document.head.querySelector('style[data-running-footer]')!;
    expect(style.textContent).toMatch(/^@page { @bottom-left { content: "[^"]*"; /);
    // Quotes, backslashes, newlines and angle brackets are hex escapes; nothing else ends the string.
    expect(style.textContent).not.toMatch(/content: "[^"]*"[^;]/);
    expect(style.textContent).toContain('\\22 final\\22 ');
    expect(style.textContent).toContain('\\5c ');
    expect(style.textContent).toContain('\\a ');
    expect(style.textContent).toContain('\\3c \\2f style\\3e ');
    expect(cssString('Mokoena Bakery, October')).toBe('"Mokoena Bakery, October"');
    unmount();
    expect(document.head.querySelector('style[data-running-footer]')).toBeNull();
  });
});
