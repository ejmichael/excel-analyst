import { isUtf8 } from 'node:buffer';

export type TextEncoding = 'utf-8' | 'windows-1252';

const BOM = [0xef, 0xbb, 0xbf] as const;

export const hasUtf8Bom = (buf: Uint8Array) => buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2];

/** UTF-8 (with or without BOM) when the bytes are valid UTF-8, otherwise Windows-1252. */
export function detectEncoding(buf: Uint8Array): TextEncoding {
  return isUtf8(buf) ? 'utf-8' : 'windows-1252';
}

const CHUNK = 1024 * 1024;

/** Decodes in 1 MB slices so a 50 MB file is never held as one giant string. The BOM is dropped. */
export function* decodeChunks(buf: Uint8Array, encoding: TextEncoding): Generator<string> {
  const start = encoding === 'utf-8' && hasUtf8Bom(buf) ? 3 : 0;
  const decoder = new TextDecoder(encoding, { ignoreBOM: true });
  for (let i = start; i < buf.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, buf.length);
    const text = decoder.decode(buf.subarray(i, end), { stream: end < buf.length });
    if (text) yield text;
  }
}

/** The first ~64 KB as text, cut at the last line break so no record is partial. */
export function decodeHead(buf: Uint8Array, encoding: TextEncoding, bytes = 64 * 1024): string {
  const start = encoding === 'utf-8' && hasUtf8Bom(buf) ? 3 : 0;
  const end = Math.min(buf.length, start + bytes);
  const text = new TextDecoder(encoding, { ignoreBOM: true }).decode(buf.subarray(start, end));
  if (end >= buf.length) return text;
  const cut = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
  return cut > 0 ? text.slice(0, cut) : text;
}
