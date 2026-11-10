import { crc32, createDeflateRaw, deflateRawSync } from 'node:zlib';

/** Test-only zip writer, so tests can build hostile workbooks (lying sizes, bombs, odd parts) byte by byte. */

export interface ZipPart {
  name: string;
  /** Uncompressed bytes (deflated here), unless `deflated` is given. */
  data?: Buffer | string;
  /** Pre-deflated bytes (method 8). */
  deflated?: Buffer;
  /** Override the uncompressed size written in the headers (to lie about it). */
  declaredSize?: number;
}

export function buildZip(parts: ZipPart[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const p of parts) {
    const raw = p.data === undefined ? Buffer.alloc(0) : Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data, 'utf8');
    const body = p.deflated ?? deflateRawSync(raw);
    const size = p.declaredSize ?? raw.length;
    const crc = p.deflated ? 0 : crc32(raw);
    const name = Buffer.from(p.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Deflates `total` bytes of a repeated chunk without holding them in memory: a real high-ratio bomb. */
export async function deflateRepeated(chunk: string, total: number): Promise<Buffer> {
  const deflate = createDeflateRaw({ level: 1 });
  const out: Buffer[] = [];
  deflate.on('data', (b: Buffer) => out.push(b));
  const piece = Buffer.alloc(1024 * 1024, chunk);
  for (let written = 0; written < total; written += piece.length) {
    if (!deflate.write(piece.subarray(0, Math.min(piece.length, total - written)))) {
      await new Promise((r) => deflate.once('drain', r));
    }
  }
  await new Promise<void>((r) => deflate.end(r));
  return Buffer.concat(out);
}

export const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`;

export const RELS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

const cell = (ref: string, v: string | number) =>
  typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;

/** A sheet with a header row and `rows` data rows of (Item, Amount). */
export function sheetXml(rows: number, extra = ''): string {
  const body = [`<row r="1">${cell('A1', 'Item')}${cell('B1', 'Amount')}</row>`];
  for (let i = 0; i < rows; i++) body.push(`<row r="${i + 2}">${cell(`A${i + 2}`, `Thing ${i % 3}`)}${cell(`B${i + 2}`, 10 + i)}</row>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${extra}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body.join('')}</sheetData></worksheet>`;
}

export function workbookZip(over: Partial<Record<'workbook' | 'rels' | 'sheet' | 'styles' | 'sharedStrings', ZipPart | string>> = {}): Buffer {
  const part = (name: string, v: ZipPart | string | undefined, fallback?: string): ZipPart[] => {
    if (v === undefined) return fallback === undefined ? [] : [{ name, data: fallback }];
    return [typeof v === 'string' ? { name, data: v } : { ...v, name }];
  };
  return buildZip([
    ...part('xl/workbook.xml', over.workbook, WORKBOOK_XML),
    ...part('xl/_rels/workbook.xml.rels', over.rels, RELS_XML),
    ...part('xl/styles.xml', over.styles),
    ...part('xl/sharedStrings.xml', over.sharedStrings),
    ...part('xl/worksheets/sheet1.xml', over.sheet, sheetXml(6)),
  ]);
}
