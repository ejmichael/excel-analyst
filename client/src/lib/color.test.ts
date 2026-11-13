import { describe, expect, it } from 'vitest';
import { DARK_TEXT, LIGHT_TEXT, MIN_CONTRAST, contrastGuidance, contrastRatio, isHexColour, readableTextOn } from './color';

describe('readableTextOn', () => {
  it.each([
    ['#000000', LIGHT_TEXT],
    ['#FFFFFF', DARK_TEXT],
    ['#1E7A5F', LIGHT_TEXT], // the accent
    ['#FF0000', DARK_TEXT], // pure red: black text reads better (5.25 vs 4.0)
    ['#FFFF00', DARK_TEXT], // yellow
    ['#777777', DARK_TEXT], // mid grey: black 4.69, white 4.48
    ['#595959', LIGHT_TEXT], // darker grey: white 7.0, black 3.0
    ['#333333', LIGHT_TEXT],
    ['#CCCCCC', DARK_TEXT],
  ])('%s gets %s', (bg, text) => {
    expect(readableTextOn(bg).text).toBe(text);
  });

  it('never returns a pair below 4.5:1, across the whole colour range', () => {
    let worst = 21;
    for (let r = 0; r <= 255; r += 15) {
      for (let g = 0; g <= 255; g += 15) {
        for (let b = 0; b <= 255; b += 15) {
          const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
          const { text, ratio } = readableTextOn(hex);
          expect(contrastRatio(hex, text)).toBeCloseTo(ratio, 10);
          worst = Math.min(worst, ratio);
        }
      }
    }
    expect(worst).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it('contrast ratio is 21 for black on white and symmetric', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#1E7A5F', '#FFFFFF')).toBeCloseTo(contrastRatio('#FFFFFF', '#1E7A5F'), 10);
  });

  it('validates #RRGGBB and explains the choice in words', () => {
    expect(isHexColour('#1e7a5f')).toBe(true);
    for (const bad of ['1E7A5F', '#1E7A5', '#1E7A5FF', '#GGGGGG', 'red']) expect(isHexColour(bad)).toBe(false);
    expect(contrastGuidance('#1E7A5F')).toMatch(/^White text is readable/);
    expect(contrastGuidance('#FFFF00')).toMatch(/^Dark text is used/);
  });
});
