import type { LogoExt } from './brand.js';

/**
 * Logo file check, from the file's bytes only (never the name or the MIME type the browser sent). PNG, JPEG and WebP
 * are accepted; the width and height come from the header without decoding the image. SVG (can carry script) and GIF
 * are refused. A file whose structure is cut short is refused as damaged.
 */

export const LOGO_LIMITS = { maxBytes: 1024 * 1024, maxSide: 4000, minSide: 16 } as const;

export type LogoCheck =
  | { ok: true; ext: LogoExt; contentType: string; width: number; height: number }
  | { ok: false; reason: 'too_large' | 'svg' | 'gif' | 'unsupported' | 'damaged' | 'too_big_dimensions' | 'too_small_dimensions' };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ascii = (buf: Buffer, start: number, end: number) => buf.subarray(start, end).toString('latin1');

/** PNG: signature, IHDR first, then every chunk must fit in the file up to IEND. */
function png(buf: Buffer): { width: number; height: number } | 'damaged' {
  if (buf.length < 33 || ascii(buf, 12, 16) !== 'IHDR' || buf.readUInt32BE(8) !== 13) return 'damaged';
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  let at = 8;
  while (at + 12 <= buf.length) {
    const length = buf.readUInt32BE(at);
    const type = ascii(buf, at + 4, at + 8);
    const next = at + 12 + length;
    if (next > buf.length) return 'damaged';
    if (type === 'IEND') return { width, height };
    at = next;
  }
  return 'damaged';
}

/** JPEG: SOI, a start-of-frame segment with the size, and an end-of-image marker after it. */
function jpeg(buf: Buffer): { width: number; height: number } | 'damaged' {
  let at = 2;
  while (at + 4 <= buf.length) {
    if (buf[at] !== 0xff) return 'damaged';
    const marker = buf[at + 1]!;
    if (marker === 0xff) {
      at++; // fill byte
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    const length = buf.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > buf.length) return 'damaged';
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (length < 7) return 'damaged';
      const height = buf.readUInt16BE(at + 5);
      const width = buf.readUInt16BE(at + 7);
      // The image data follows; it must end with EOI (FF D9), allowing a little trailing padding.
      const tail = buf.subarray(Math.max(at + 2 + length, buf.length - 64));
      return tail.includes(Buffer.from([0xff, 0xd9])) ? { width, height } : 'damaged';
    }
    if (marker === 0xda || marker === 0xd9) return 'damaged'; // scan or end before any frame header
    at += 2 + length;
  }
  return 'damaged';
}

/** WebP: RIFF container whose declared size fits the file, then VP8X, VP8 (lossy) or VP8L (lossless) for the size. */
function webp(buf: Buffer): { width: number; height: number } | 'damaged' {
  if (buf.length < 30) return 'damaged';
  const riffSize = buf.readUInt32LE(4);
  if (riffSize + 8 > buf.length) return 'damaged';
  const chunk = ascii(buf, 12, 16);
  if (chunk === 'VP8X') {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  if (chunk === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return 'damaged';
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return 'damaged';
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return 'damaged';
}

function looksLikeSvg(buf: Buffer): boolean {
  const head = buf.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg')) || (head.startsWith('<!doctype svg'));
}

export function checkLogo(buf: Buffer): LogoCheck {
  if (buf.length > LOGO_LIMITS.maxBytes) return { ok: false, reason: 'too_large' };
  let kind: { ext: LogoExt; contentType: string; size: { width: number; height: number } | 'damaged' };
  if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) kind = { ext: 'png', contentType: 'image/png', size: png(buf) };
  else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) kind = { ext: 'jpg', contentType: 'image/jpeg', size: jpeg(buf) };
  else if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') kind = { ext: 'webp', contentType: 'image/webp', size: webp(buf) };
  else if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') return { ok: false, reason: 'gif' };
  else if (looksLikeSvg(buf)) return { ok: false, reason: 'svg' };
  else return { ok: false, reason: 'unsupported' };

  if (kind.size === 'damaged') return { ok: false, reason: 'damaged' };
  const { width, height } = kind.size;
  if (width > LOGO_LIMITS.maxSide || height > LOGO_LIMITS.maxSide) return { ok: false, reason: 'too_big_dimensions' };
  if (width < LOGO_LIMITS.minSide || height < LOGO_LIMITS.minSide) return { ok: false, reason: 'too_small_dimensions' };
  return { ok: true, ext: kind.ext, contentType: kind.contentType, width, height };
}
