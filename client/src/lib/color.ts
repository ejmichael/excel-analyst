/**
 * Text colour on a brand colour, by WCAG 2 contrast. Colour maths only; no figure from the user's data.
 * With pure black and pure white as the candidates, the better one is always at least about 4.58:1, so text on
 * a brand colour never falls below the 4.5:1 minimum for normal text.
 */

export const DARK_TEXT = '#000000';
export const LIGHT_TEXT = '#FFFFFF';
export const MIN_CONTRAST = 4.5;

const HEX = /^#([0-9a-f]{6})$/i;

export function isHexColour(value: string): boolean {
  return HEX.test(value.trim());
}

/** WCAG relative luminance of a #RRGGBB colour. */
export function relativeLuminance(hex: string): number {
  const m = HEX.exec(hex.trim());
  if (!m) throw new Error(`Not a #RRGGBB colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  const channel = (shift: number) => {
    const c = ((n >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/** WCAG contrast ratio between two #RRGGBB colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on `hex`, with its contrast ratio. */
export function readableTextOn(hex: string): { text: typeof DARK_TEXT | typeof LIGHT_TEXT; ratio: number } {
  const dark = contrastRatio(hex, DARK_TEXT);
  const light = contrastRatio(hex, LIGHT_TEXT);
  return light >= dark ? { text: LIGHT_TEXT, ratio: light } : { text: DARK_TEXT, ratio: dark };
}

/** Guidance in words for a chosen brand colour. */
export function contrastGuidance(hex: string): string {
  return readableTextOn(hex).text === LIGHT_TEXT
    ? 'White text is readable on this colour, so the report header uses white text.'
    : 'Dark text is used on this colour, because white text would be hard to read on it.';
}
