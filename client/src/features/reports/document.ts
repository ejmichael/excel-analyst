import type { CSSProperties } from 'react';
import type { Brand } from '@/api/types';
import { DEFAULT_BRAND, isHexColour, markColour, tintColour } from '@/lib/color';

/** How much of the brand colour tints a printed table's header row (the rest is white). */
export const TABLE_TINT = 0.09;

/**
 * The CSS variables a report document reads (report-doc.css): the brand for the top rule, the brand guarded to 3:1
 * on white for marks (the first chart series, the check tick), and the table header tint. Colours only, no figures.
 */
export function documentVars(brand: Pick<Brand, 'color'>): CSSProperties {
  const colour = isHexColour(brand.color) ? brand.color.toUpperCase() : DEFAULT_BRAND;
  return {
    '--brand': colour,
    '--brand-mark': markColour(colour),
    '--brand-tint': tintColour(colour, TABLE_TINT),
  } as CSSProperties;
}
