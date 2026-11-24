/**
 * Chart series colours. Colour is never the only cue: line and area series also differ by dash pattern, every chart
 * with more than one series has a text legend, value labels where they fit, and a table view.
 *
 * Report palette (the owner's report view on screen, and every chart before W2c): ten colours, every pair at least 25
 * apart in CIE76 ΔE (tested), starting from the accent. Print and the shared page swap in the brand-first colours below.
 */
export const CHART_COLOURS = [
  '#1E7A5F',
  '#E69F00',
  '#0072B2',
  '#CC79A7',
  '#56B4E9',
  '#D55E00',
  '#6A3D9A',
  '#8C510A',
  '#6B7280',
  '#F0E442',
] as const;

/**
 * App palette (W2c): Dashboard widgets and Ask answer cards. Every colour at least 3:1 on white and every pair at least
 * 25 apart (tested). The orange is #EA5008 rather than #EA580C, which was 21.9 from the amber.
 */
export const FRESH_COLOURS = [
  '#0E9F6E',
  '#2563EB',
  '#D97706',
  '#7C3AED',
  '#E11D48',
  '#0891B2',
  '#65A30D',
  '#475569',
  '#EA5008',
  '#C026D3',
] as const;

/** 'report': the report palette, which a report document can swap; 'fresh': the app palette. */
export type ChartPalette = 'report' | 'fresh';

/**
 * Report documents (print and the shared page): the brand's mark colour first, then these in order, skipping any
 * that is not clearly different from those already chosen (lib/color.ts distinctPalette). No other greens.
 */
export const DOCUMENT_CANDIDATES = [
  '#E0A100',
  '#1B6FA8',
  '#C77DA5',
  '#5EC0F2',
  '#D55E00',
  '#6A3D9A',
  '#8C510A',
  '#6B7280',
  '#F0E442',
  '#1F2A44',
  '#B8336A',
  '#FF8FAB',
  '#3A3A3A',
  '#9C6ADE',
  '#F4A261',
  '#7B2D26',
  '#B5B5B5',
] as const;

/** Distinct colours per chart; a series beyond these is drawn with a hatch pattern over a palette colour. */
export const SERIES_COLOURS = CHART_COLOURS.length;

/** Line dashes per series, paired with the colours above ('' = solid). */
export const CHART_DASHES = ['', '6 3', '2 3', '8 3 2 3', '1 4', '10 4'] as const;

/**
 * A series colour as a CSS variable with the app colour as its fallback, so a report document (print or the shared
 * page) can swap in its own series colours (the brand first) without drawing the chart differently.
 */
export const colourAt = (i: number, palette: ChartPalette = 'report') => {
  const n = i % SERIES_COLOURS;
  return palette === 'fresh' ? FRESH_COLOURS[n]! : `var(--series-${n + 1}, ${CHART_COLOURS[n]!})`;
};

/** True when series `i` needs a hatch pattern to stay distinct (more series than colours). */
export const isHatched = (i: number) => i >= SERIES_COLOURS;

/** The id of the hatch pattern for series `i` in the chart `chartId` (see HatchDefs in BlockChart). */
export const hatchId = (chartId: string, i: number) => `${chartId}-hatch-${i}`;

/** The fill for a bar, area or pie slice: the colour, or past the tenth series a hatched version of a colour. */
export const fillAt = (chartId: string, i: number, palette: ChartPalette = 'report') =>
  isHatched(i) ? `url(#${hatchId(chartId, i)})` : colourAt(i, palette);

/** The same for an HTML swatch (a legend outside the SVG): diagonal stripes past the tenth series. */
export const swatchAt = (i: number, palette: ChartPalette = 'report') =>
  isHatched(i) ? `repeating-linear-gradient(45deg, ${colourAt(i, palette)} 0 3px, #ffffff 3px 5px)` : colourAt(i, palette);

export const dashAt = (i: number) => CHART_DASHES[i % CHART_DASHES.length]!;
