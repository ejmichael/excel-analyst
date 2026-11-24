import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio } from '@/lib/color';

const SRC = join(process.cwd(), 'src');
const css = readFileSync(join(SRC, 'index.css'), 'utf8');

/** The custom properties declared in the first rule block whose selector is `selector`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

const app = tokens(':root');
const classic = tokens('[data-classic-theme]');

describe('the app theme (W2c): a cool near-white page', () => {
  it('has the new values', () => {
    expect(app).toMatchObject({
      background: '#f8fafc',
      foreground: '#0f172a',
      card: '#ffffff',
      'muted-foreground': '#475569',
      border: '#e2e8f0',
      muted: '#f1f5f9',
      secondary: '#f1f5f9',
      accent: '#e7f5ee',
      input: '#7c8ba1',
      'card-shadow': '0 1px 2px rgba(15, 23, 42, 0.04)',
    });
  });

  it('keeps the green accent, the status colours and the focus ring', () => {
    expect(app).toMatchObject({ primary: '#1e7a5f', ring: '#1e7a5f', destructive: '#b42318', warning: '#8a5a00', 'warning-bg': '#fdf4e3' });
  });

  it('declares its tokens in one place: no other file sets them or writes the new colours out', () => {
    // report-doc.css sets the report document's own ink and hairlines (Part 5b), which W2c leaves alone.
    const others = files(SRC).filter((f) => /\.(css|tsx?)$/.test(f) && !/\.test\.tsx?$/.test(f) && !/(index|report-doc)\.css$/.test(f));
    for (const file of others) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/--(background|foreground|muted|secondary|accent|input|card-shadow):/);
      expect(text.toLowerCase(), file).not.toMatch(/#(f8fafc|0f172a|e2e8f0|f1f5f9|e7f5ee|7c8ba1)\b/);
    }
  });

  it('every text and control pair meets WCAG AA', () => {
    const surfaces = [app.background!, app.card!, app.muted!, app.accent!];
    for (const surface of surfaces) {
      expect(contrastRatio(app.foreground!, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(app['muted-foreground']!, surface)).toBeGreaterThanOrEqual(4.5);
      // Links, tab labels and the active sidebar icon.
      expect(contrastRatio(app.primary!, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(app.ring!, surface)).toBeGreaterThanOrEqual(3);
    }
    expect(contrastRatio(app['primary-foreground']!, app.primary!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(app['destructive-foreground']!, app.destructive!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(app.destructive!, app.card!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(app.warning!, app['warning-bg']!)).toBeGreaterThanOrEqual(4.5);
    // Form field borders: at least 3:1 on white and on the page.
    expect(contrastRatio(app.input!, app.card!)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(app.input!, app.background!)).toBeGreaterThanOrEqual(3);
  });
});

describe('report pages keep their tokens', () => {
  it('the owner report view and the shared page pin the warm values they had before W2c', () => {
    expect(classic).toEqual({
      background: '#f6f5f0',
      foreground: '#16231f',
      'card-foreground': '#16231f',
      'card-shadow': 'none',
      'popover-foreground': '#16231f',
      secondary: '#ecebe4',
      'secondary-foreground': '#16231f',
      muted: '#ecebe4',
      'muted-foreground': '#4f5b56',
      accent: '#e3efe9',
      'accent-foreground': '#16231f',
      border: '#d9d8ce',
      input: '#c9c8bd',
    });
    for (const page of ['features/reports/ReportPage.tsx', 'features/public/PublicReportPage.tsx']) {
      expect(readFileSync(join(SRC, page), 'utf8'), page).toMatch(/data-classic-theme/);
    }
  });
});
