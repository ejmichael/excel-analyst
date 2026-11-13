import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkLogo, LOGO_LIMITS } from '../../src/services/logo.js';

// Real images made with ffmpeg (test/unit/logos/): 64 x 48 PNG, JPEG and WebP (lossy VP8 and lossless VP8L), a GIF,
// a 4001 x 20 PNG and an 8 x 8 PNG.
const logo = (name: string) => readFileSync(new URL(`logos/${name}`, import.meta.url));

describe('logo byte check: accepted', () => {
  it.each([
    ['logo.png', 'png', 'image/png'],
    ['logo.jpg', 'jpg', 'image/jpeg'],
    ['logo-lossy.webp', 'webp', 'image/webp'],
    ['logo-lossless.webp', 'webp', 'image/webp'],
  ])('%s', (name, ext, contentType) => {
    expect(checkLogo(logo(name))).toEqual({ ok: true, ext, contentType, width: 64, height: 48 });
  });

  it('an extended (VP8X) WebP header gives the canvas size', () => {
    const buf = Buffer.alloc(40);
    buf.write('RIFF', 0, 'latin1');
    buf.writeUInt32LE(32, 4);
    buf.write('WEBPVP8X', 8, 'latin1');
    buf.writeUInt32LE(10, 16);
    buf.writeUIntLE(199, 24, 3); // width - 1
    buf.writeUIntLE(99, 27, 3); // height - 1
    expect(checkLogo(buf)).toMatchObject({ ok: true, ext: 'webp', width: 200, height: 100 });
  });

  it('the name and MIME type play no part: a PNG is a PNG whatever it is called', () => {
    // checkLogo only ever receives bytes; this documents that a PNG renamed .jpg is stored as .png.
    expect(checkLogo(logo('logo.png'))).toMatchObject({ ext: 'png' });
  });
});

describe('logo byte check: refused', () => {
  it('an SVG (with or without an XML declaration)', () => {
    expect(checkLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toEqual({ ok: false, reason: 'svg' });
    expect(checkLogo(Buffer.from('﻿<?xml version="1.0"?>\n<svg width="10" height="10"></svg>'))).toEqual({ ok: false, reason: 'svg' });
  });

  it('a GIF', () => {
    expect(checkLogo(logo('logo.gif'))).toEqual({ ok: false, reason: 'gif' });
  });

  it('a text file renamed .png', () => {
    expect(checkLogo(Buffer.from('This is not an image, just text saved as logo.png\n'))).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('a truncated PNG, JPEG and WebP', () => {
    const png = logo('logo.png');
    expect(checkLogo(png.subarray(0, png.length - 20))).toEqual({ ok: false, reason: 'damaged' });
    expect(checkLogo(png.subarray(0, 30))).toEqual({ ok: false, reason: 'damaged' });
    const jpg = logo('logo.jpg');
    expect(checkLogo(jpg.subarray(0, Math.floor(jpg.length / 2)))).toEqual({ ok: false, reason: 'damaged' });
    const webp = logo('logo-lossy.webp');
    expect(checkLogo(webp.subarray(0, webp.length - 10))).toEqual({ ok: false, reason: 'damaged' });
  });

  it('a PNG wider than 4000 px, and one smaller than 16 px', () => {
    expect(checkLogo(logo('wide.png'))).toEqual({ ok: false, reason: 'too_big_dimensions' });
    expect(checkLogo(logo('tiny.png'))).toEqual({ ok: false, reason: 'too_small_dimensions' });
  });

  it('a PNG header claiming a huge size is refused from the header alone (nothing is decoded)', () => {
    const png = Buffer.from(logo('logo.png'));
    png.writeUInt32BE(50_000, 16); // IHDR width
    expect(checkLogo(png)).toEqual({ ok: false, reason: 'too_big_dimensions' });
  });

  it('more than 1 MB', () => {
    const big = Buffer.concat([logo('logo.png'), Buffer.alloc(LOGO_LIMITS.maxBytes)]);
    expect(checkLogo(big)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('empty or tiny input', () => {
    expect(checkLogo(Buffer.alloc(0))).toEqual({ ok: false, reason: 'unsupported' });
    expect(checkLogo(Buffer.from([0x89, 0x50]))).toEqual({ ok: false, reason: 'unsupported' });
  });
});
