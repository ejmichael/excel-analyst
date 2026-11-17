/**
 * Chart series colours. Colour is never the only cue: line and area series also differ by dash pattern, every chart
 * with more than one series has a text legend, value labels where they fit, and a table view.
 *
 * App palette: ten colours, every pair at least 25 apart in CIE76 ΔE (tested), starting from the accent.
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
export const colourAt = (i: number) => {
  const n = i % SERIES_COLOURS;
  return `var(--series-${n + 1}, ${CHART_COLOURS[n]!})`;
};

/** True when series `i` needs a hatch pattern to stay distinct (more series than colours). */
export const isHatched = (i: number) => i >= SERIES_COLOURS;

/** The id of the hatch pattern for series `i` in the chart `chartId` (see HatchDefs in BlockChart). */
export const hatchId = (chartId: string, i: number) => `${chartId}-hatch-${i}`;

/** The fill for a bar, area or pie slice: the colour, or past the tenth series a hatched version of a colour. */
export const fillAt = (chartId: string, i: number) => (isHatched(i) ? `url(#${hatchId(chartId, i)})` : colourAt(i));

/** The same for an HTML swatch (a legend outside the SVG): diagonal stripes past the tenth series. */
export const swatchAt = (i: number) =>
  isHatched(i) ? `repeating-linear-gradient(45deg, ${colourAt(i)} 0 3px, #ffffff 3px 5px)` : colourAt(i);

export const dashAt = (i: number) => CHART_DASHES[i % CHART_DASHES.length]!;
