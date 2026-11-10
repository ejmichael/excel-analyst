import { describe, expect, it } from 'vitest';
import { MOCK_PLAN_LIMITS } from '@/api/mocks/data';
import { checkFile } from './uploadValidation';

const fileOf = (name: string, bytes: number) => {
  const file = new File(['x'], name);
  Object.defineProperty(file, 'size', { value: bytes });
  return file;
};
const free = MOCK_PLAN_LIMITS.free; // max_file_mb: 5

describe('checkFile', () => {
  it('accepts .csv, .txt and .xlsx, in any case', () => {
    for (const name of ['sales.csv', 'export.TXT', 'Book1.xlsx']) {
      expect(checkFile(fileOf(name, 1000), free)).toEqual({ ok: true });
    }
  });

  it('rejects other types with a written message, before sending', () => {
    const result = checkFile(fileOf('report.pdf', 1000), free);
    expect(result).toMatchObject({ ok: false, reason: 'type' });
    if (!result.ok && result.reason === 'type') expect(result.message).toMatch(/not a CSV, TXT or Excel/);
    expect(checkFile(fileOf('old.xls', 1000), free)).toMatchObject({ ok: false, reason: 'type' });
  });

  it('rejects an empty file', () => {
    expect(checkFile(fileOf('empty.csv', 0), free)).toMatchObject({ ok: false, reason: 'type' });
  });

  it('compares the size with the plan limit and returns the max_file_mb limit', () => {
    expect(checkFile(fileOf('ok.csv', 5 * 1024 * 1024), free)).toEqual({ ok: true });
    const result = checkFile(fileOf('big.csv', 5 * 1024 * 1024 + 1), free);
    expect(result).toEqual({
      ok: false,
      reason: 'size',
      // Megabytes rounded up to 2 decimals, the same number the server reports.
      limit: { limit_key: 'max_file_mb', limit: 5, used: 5.01 },
    });
  });
});
