import { AppError } from '../../lib/errors.js';
import type { FileType } from '../../types/api.js';
import { detectDelimiter } from './delimiter.js';
import { decodeHead, detectEncoding } from './encoding.js';
import { XLSX_MESSAGES } from './sources.js';
import { checkZipLimits, XlsxError } from './xlsx.js';
import { isOleCompoundFile, isZip, listEntries } from './zip.js';

/**
 * Decides the file type from its bytes, never from the extension or the browser's MIME type.
 * XLSX: a real zip containing xl/workbook.xml. CSV: text with no NUL bytes and a consistent delimiter.
 * Anything else is 415 file_unsupported.
 */
export function checkFileContent(buf: Buffer): { fileType: FileType; ext: 'csv' | 'xlsx' } {
  if (buf.length === 0) throw new AppError('file_unsupported', 'This file is empty.');
  if (isOleCompoundFile(buf)) {
    throw new AppError(
      'file_unsupported',
      'This looks like an old .xls file or a password-protected workbook. Save it as .xlsx or CSV and upload it again.',
    );
  }
  if (isZip(buf)) {
    const entries = listEntries(buf);
    if (!entries || !entries.some((e) => e.name === 'xl/workbook.xml')) {
      throw new AppError('file_unsupported', 'This is a zip file but not an Excel workbook. Upload a .xlsx or CSV file.');
    }
    // Zip-bomb checks from the directory alone, before anything is stored or inflated.
    try {
      checkZipLimits(entries);
    } catch (err) {
      throw new AppError('file_unsupported', err instanceof XlsxError ? XLSX_MESSAGES[err.reason] : XLSX_MESSAGES.damaged);
    }
    if (entries.some((e) => e.encrypted)) {
      throw new AppError('file_unsupported', 'This workbook is encrypted. Remove the password and upload it again.');
    }
    return { fileType: 'xlsx', ext: 'xlsx' };
  }
  if (buf.includes(0)) {
    throw new AppError(
      'file_unsupported',
      'This is not a CSV or Excel file. If it is a CSV saved as UTF-16 (Unicode text), save it as CSV UTF-8 instead.',
    );
  }
  if (!detectDelimiter(decodeHead(buf, detectEncoding(buf)))) {
    throw new AppError('file_unsupported', 'We could not find separate columns in this file. Upload a CSV or .xlsx file.');
  }
  return { fileType: 'csv', ext: 'csv' };
}
