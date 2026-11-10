import { inflateRawSync, createInflateRaw } from 'node:zlib';
import { Readable } from 'node:stream';

/** Minimal read-only zip central-directory reader: enough to check an XLSX and guard against zip bombs. */

export interface ZipEntry {
  name: string;
  method: number; // 0 stored, 8 deflate
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export const isZip = (buf: Buffer) => buf.length >= 4 && buf.readUInt32LE(0) === LOC_SIG;

/** Legacy .xls (and password-protected .xlsx) are OLE compound files. */
export const isOleCompoundFile = (buf: Buffer) =>
  buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));

/** Lists the entries, or returns null when the central directory is missing or malformed (or ZIP64). */
export function listEntries(buf: Buffer): ZipEntry[] | null {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) return null; // ZIP64: not expected for files of at most 50 MB
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) return null;
    const flags = buf.readUInt16LE(p + 8);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    if (p + 46 + nameLen > buf.length) return null;
    entries.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      uncompressedSize: buf.readUInt32LE(p + 24),
      localHeaderOffset: buf.readUInt32LE(p + 42),
      encrypted: (flags & 1) === 1,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function dataRange(buf: Buffer, e: ZipEntry): [number, number] {
  const o = e.localHeaderOffset;
  if (o + 30 > buf.length || buf.readUInt32LE(o) !== LOC_SIG) throw new Error('bad local header');
  const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
  return [start, start + e.compressedSize];
}

/** Reads a small entry fully (workbook.xml, rels). Refuses entries above `maxBytes` once inflated. */
export function readEntry(buf: Buffer, e: ZipEntry, maxBytes = 5 * 1024 * 1024): Buffer {
  if (e.uncompressedSize > maxBytes) throw new Error('entry too large');
  const [start, end] = dataRange(buf, e);
  const raw = buf.subarray(start, end);
  if (e.method === 0) return raw;
  if (e.method !== 8) throw new Error('unsupported compression');
  return inflateRawSync(raw, { maxOutputLength: maxBytes });
}

/** Streams an entry's text in chunks, stopping with an error past `maxBytes` of output (zip-bomb guard). */
export async function* streamEntryText(buf: Buffer, e: ZipEntry, maxBytes: number): AsyncGenerator<string> {
  const [start, end] = dataRange(buf, e);
  const raw = buf.subarray(start, end);
  const source = Readable.from([raw]);
  const stream = e.method === 0 ? source : source.pipe(createInflateRaw());
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new Error('entry too large');
    }
    yield decoder.decode(chunk, { stream: true });
  }
}
