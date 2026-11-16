import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { checkLogo, LOGO_LIMITS, stripLogoMetadata } from '../../src/services/logo.js';

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

describe('logo metadata is stripped', () => {
  const SECRET = 'GPS -26.2041 28.0473 Thandi Nkosi iPhone';

  function pngChunk(type: string, data: Buffer): Buffer {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  }

  it('PNG: tEXt, iTXt, zTXt, eXIf and tIME chunks go; the image chunks stay byte for byte', () => {
    const src = logo('logo.png');
    const ihdrEnd = 8 + 12 + 13;
    const extra = Buffer.concat([
      pngChunk('tEXt', Buffer.from(`Author\0${SECRET}`)),
      pngChunk('iTXt', Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${SECRET}`)),
      pngChunk('eXIf', Buffer.from(`MM\0*${SECRET}`)),
      pngChunk('tIME', Buffer.from([7, 234, 11, 16, 10, 0, 0])),
    ]);
    const dirty = Buffer.concat([src.subarray(0, ihdrEnd), extra, src.subarray(ihdrEnd)]);
    expect(checkLogo(dirty)).toMatchObject({ ok: true, ext: 'png', width: 64, height: 48 });
    const clean = stripLogoMetadata(dirty, 'png');
    expect(clean.toString('latin1')).not.toContain('Thandi');
    expect(clean.equals(src)).toBe(true);
  });

  it('JPEG: EXIF/XMP (APP1), IPTC (APP13) and comments go; JFIF and the image stay', () => {
    const src = logo('logo.jpg');
    const segment = (marker: number, data: Buffer) => {
      const head = Buffer.from([0xff, marker, 0, 0]);
      head.writeUInt16BE(data.length + 2, 2);
      return Buffer.concat([head, data]);
    };
    const dirty = Buffer.concat([
      src.subarray(0, 2),
      segment(0xe1, Buffer.from(`Exif\0\0${SECRET}`)),
      segment(0xed, Buffer.from(`Photoshop 3.0\0${SECRET}`)),
      segment(0xfe, Buffer.from(SECRET)),
      src.subarray(2),
    ]);
    expect(checkLogo(dirty)).toMatchObject({ ok: true, ext: 'jpg', width: 64, height: 48 });
    const clean = stripLogoMetadata(dirty, 'jpg');
    expect(clean.toString('latin1')).not.toContain('Thandi');
    expect(checkLogo(clean)).toMatchObject({ ok: true, ext: 'jpg', width: 64, height: 48 });
    expect(clean.length).toBeLessThanOrEqual(src.length);
  });

  it('WebP (extended): EXIF and XMP chunks go, their flags are cleared and the RIFF size is fixed', () => {
    const vp8 = logo('logo-lossy.webp').subarray(12); // the VP8 chunk of a simple lossy file
    const chunk = (type: string, data: Buffer) => {
      const head = Buffer.alloc(8);
      head.write(type, 0, 'latin1');
      head.writeUInt32LE(data.length, 4);
      return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const vp8xData = Buffer.alloc(10);
    vp8xData[0] = 0x0c; // EXIF and XMP present
    vp8xData.writeUIntLE(63, 4, 3);
    vp8xData.writeUIntLE(47, 7, 3);
    const body = Buffer.concat([chunk('VP8X', vp8xData), vp8, chunk('EXIF', Buffer.from(`MM\0*${SECRET}`)), chunk('XMP ', Buffer.from(`<x>${SECRET}</x>`))]);
    const header = Buffer.from('RIFF0000WEBP', 'latin1');
    header.writeUInt32LE(body.length + 4, 4);
    const dirty = Buffer.concat([header, body]);
    expect(checkLogo(dirty)).toMatchObject({ ok: true, ext: 'webp', width: 64, height: 48 });

    const clean = stripLogoMetadata(dirty, 'webp');
    expect(clean.toString('latin1')).not.toContain('Thandi');
    expect(clean.readUInt32LE(4)).toBe(clean.length - 8);
    expect(clean[20]! & 0x0c).toBe(0);
    expect(checkLogo(clean)).toMatchObject({ ok: true, ext: 'webp', width: 64, height: 48 });
    expect(clean.includes(vp8)).toBe(true);
  });

  it('files without metadata come back unchanged', () => {
    for (const [name, ext] of [['logo.png', 'png'], ['logo-lossless.webp', 'webp']] as const) {
      expect(stripLogoMetadata(logo(name), ext).equals(logo(name))).toBe(true);
    }
  });
});
