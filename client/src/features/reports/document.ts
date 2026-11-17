import type { CSSProperties } from 'react';
import type { Brand } from '@/api/types';
import { DEFAULT_BRAND, distinctPalette, isHexColour, markColour, tintColour } from '@/lib/color';
import { DOCUMENT_CANDIDATES, SERIES_COLOURS } from '@/features/ask/chartPalette';

/** How much of the brand colour tints a printed table's header row (the rest is white). */
export const TABLE_TINT = 0.09;

/**
 * The CSS variables a report document reads (report-doc.css): the brand for the top rule, the brand guarded to 3:1
 * on white for marks (the first chart series, the check tick), the table header tint, and the series colours (the
 * mark colour first, then clearly different ones). Colours only, no figures.
 */
export function documentVars(brand: Pick<Brand, 'color'>): CSSProperties {
  const colour = isHexColour(brand.color) ? brand.color.toUpperCase() : DEFAULT_BRAND;
  const mark = markColour(colour);
  const series = distinctPalette(mark, DOCUMENT_CANDIDATES, SERIES_COLOURS);
  return {
    '--brand': colour,
    '--brand-mark': mark,
    '--brand-tint': tintColour(colour, TABLE_TINT),
    ...Object.fromEntries(series.map((c, i) => [`--doc-series-${i + 1}`, c])),
  } as CSSProperties;
}
