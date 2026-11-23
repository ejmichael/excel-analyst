/**
 * Spreadsheet formula errors (a broken formula in the source file) are not values: they are read as empty, counted per
 * column, and reported in the dataset's warnings. Applies to CSV text and XLSX cells alike (an XLSX cell of error type
 * arrives here as its error code).
 */

export const SPREADSHEET_ERRORS = new Set([
  '#ERROR!',
  '#N/A',
  '#REF!',
  '#DIV/0!',
  '#VALUE!',
  '#NAME?',
  '#NULL!',
  '#NUM!',
  '#SPILL!',
  '#CALC!',
  '#GETTING_DATA',
]);

export const isSpreadsheetError = (cell: string) => cell.length <= 20 && cell.includes('#') && SPREADSHEET_ERRORS.has(cell.trim().toUpperCase());

/** Empties every error cell in place; returns the column indexes that held one. */
export function scrubErrors(cells: string[]): number[] {
  const hit: number[] = [];
  for (let c = 0; c < cells.length; c++) {
    if (isSpreadsheetError(cells[c]!)) {
      cells[c] = '';
      hit.push(c);
    }
  }
  return hit;
}

const MAX_ERROR_LINES = 5;

/** One warning per affected column (at most 5), then one line for the rest. */
export function errorWarnings(names: string[], counts: number[]): string[] {
  const hit = counts.map((n, c) => ({ name: names[c]!, n })).filter((x) => x.n > 0);
  const lines = hit
    .slice(0, MAX_ERROR_LINES)
    .map(({ name, n }) => `${name}: ${n} ${n === 1 ? 'cell' : 'cells'} held a spreadsheet error such as #ERROR! and ${n === 1 ? 'was' : 'were'} read as empty.`);
  const rest = hit.length - MAX_ERROR_LINES;
  if (rest > 0) lines.push(`and ${rest} more ${rest === 1 ? 'column' : 'columns'} also held spreadsheet errors.`);
  return lines;
}
