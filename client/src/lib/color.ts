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

/** The app accent, used for a report's marks when the owner has not chosen a brand colour. */
export const DEFAULT_BRAND = '#1E7A5F';

/** Marks (a chart's first series, the check tick) need at least 3:1 against white paper to be seen (WCAG 1.4.11). */
export const MIN_MARK_CONTRAST = 3;

function toRgb(hex: string): [number, number, number] {
  const m = HEX.exec(hex.trim());
  if (!m) throw new Error(`Not a #RRGGBB colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

/**
 * The brand colour for marks on white paper (a chart's first series, the check tick): the colour itself when it has
 * at least 3:1 against white, otherwise the same hue stepped darker until it does. Text is never set on it.
 */
export function markColour(hex: string): string {
  if (contrastRatio(hex, LIGHT_TEXT) >= MIN_MARK_CONTRAST) return hex.toUpperCase();
  const [h, s, l] = rgbToHsl(toRgb(hex));
  for (let lightness = l; lightness > 0; lightness -= 0.02) {
    const candidate = toHex(hslToRgb([h, s, lightness]));
    if (contrastRatio(candidate, LIGHT_TEXT) >= MIN_MARK_CONTRAST) return candidate;
  }
  return DARK_TEXT;
}

/** `hex` mixed into white by `amount` (0 to 1): the table header tint of a printed report. */
export function tintColour(hex: string, amount: number): string {
  const rgb = toRgb(hex);
  return toHex(rgb.map((c) => 255 + (c - 255) * amount) as [number, number, number]);
}

/** CIE L*a*b* of a #RRGGBB colour (sRGB, D65). */
function toLab(hex: string): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = toRgb(hex).map(lin) as [number, number, number];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 colour difference: about 2.3 is just noticeable; 25 or more reads as a clearly different colour. */
export function deltaE76(a: string, b: string): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Colours that read as clearly different (CIE76 ΔE). */
export const MIN_SERIES_DELTA_E = 25;

/**
 * `count` colours that are clearly different from each other: `first`, then each candidate in order that is at least
 * `minDelta` away from every colour already chosen. Fewer if the candidates run out.
 */
export function distinctPalette(first: string, candidates: readonly string[], count: number, minDelta = MIN_SERIES_DELTA_E): string[] {
  const chosen = [first.toUpperCase()];
  for (const c of candidates) {
    if (chosen.length >= count) break;
    if (chosen.every((p) => deltaE76(p, c) >= minDelta)) chosen.push(c.toUpperCase());
  }
  return chosen;
}
