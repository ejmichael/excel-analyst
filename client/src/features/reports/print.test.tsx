import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DownloadPdfButton, PDF_HINT, PrintFooter } from './print';

const css = readFileSync(resolve(__dirname, '../../styles/print.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** The body of the @media print block. */
const printBlock = css.slice(css.indexOf('@media print'));
/** The declarations of the first rule whose selector list contains `selector`. */
const rule = (selector: string) => {
  const at = printBlock.indexOf(selector);
  expect(at, `print rule for ${selector}`).toBeGreaterThan(-1);
  return printBlock.slice(printBlock.indexOf('{', at), printBlock.indexOf('}', at));
};

afterEach(() => vi.restoreAllMocks());

describe('Download PDF', () => {
  it('opens the print window and says how to save a PDF', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<DownloadPdfButton />);
    const button = screen.getByRole('button', { name: 'Download PDF' });
    expect(button).toHaveAccessibleDescription(PDF_HINT);
    await userEvent.click(button);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('the printed footer is print-only and dated', () => {
    render(<PrintFooter title="October review" />);
    const footer = screen.getByText(/October review · Printed/);
    expect(footer).toHaveAttribute('data-print', 'only');
    expect(footer).toHaveTextContent('Check important figures against your source file.');
  });
});

describe('the print stylesheet', () => {
  it('is loaded by the app', () => {
    expect(readFileSync(resolve(__dirname, '../../index.css'), 'utf8')).toMatch(/@import '\.\/styles\/print\.css'/);
  });

  it('prints on A4 portrait with margins and page numbers', () => {
    expect(css).toMatch(/@page\s*{[^}]*size:\s*A4 portrait/);
    expect(css).toMatch(/margin:\s*14mm 12mm 16mm/);
    expect(css).toMatch(/counter\(page\)/);
  });

  it('hides the app chrome, buttons, banners, dialogs and edit controls; prints the shell as one column', () => {
    const hidden = rule("[data-print='hide']");
    expect(hidden).toMatch(/display:\s*none !important/);
    for (const selector of ['nav', 'aside', "button:not([data-print='keep'])", "[role='dialog']"]) expect(printBlock).toContain(selector);
    expect(rule('[data-print-shell]')).toMatch(/display:\s*block !important/);
  });

  it('prints "How this was calculated" closed', () => {
    expect(printBlock).toMatch(/\[data-print-disclosure\]\s*{\s*display:\s*none !important/);
  });

  it('keeps answers together where they fit and lets a long table continue', () => {
    expect(rule('[data-print-answer] {')).toMatch(/break-inside:\s*avoid/);
    expect(printBlock).toMatch(/:has\(\[data-print-table\] tbody tr:nth-child\(20\)\)\s*{\s*break-inside:\s*auto/);
  });

  it('never clips a table and repeats its header row', () => {
    expect(rule('[data-print-table] {')).toMatch(/max-height:\s*none !important;\s*overflow:\s*visible !important/);
    expect(rule('[data-print-table] thead')).toMatch(/display:\s*table-header-group/);
    expect(rule('[data-print-table] td {')).toMatch(/overflow-wrap:\s*break-word/);
    // Amounts are never split across lines; wide tables print smaller so every column fits.
    expect(rule('[data-print-table] td[data-numeric]')).toMatch(/white-space:\s*nowrap !important/);
    expect(rule('table:has(thead th:nth-child(8))')).toMatch(/font-size:\s*7\.5pt/);
  });

  it('prints the brand band and chart colours as they are, and scales charts to the page', () => {
    expect(rule('[data-brand-band],')).toMatch(/print-color-adjust:\s*exact/);
    expect(rule('svg.recharts-surface {')).toMatch(/max-width:\s*100% !important/);
  });

  it('only-print content is hidden on screen and shown in print', () => {
    expect(css.slice(0, css.indexOf('@page'))).toMatch(/\[data-print='only'\]\s*{\s*display:\s*none/);
    expect(rule("[data-print='only'] {")).toMatch(/display:\s*block !important/);
  });
});
