import type { PlanLimits } from '@/api/types';
import type { LocalPlanLimit } from '@/components/UpgradeDialog';

export const ACCEPTED_EXTENSIONS = ['.csv', '.txt', '.xlsx'] as const;
export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(',');

/** Size in MB (1024 × 1024 bytes), rounded up to 2 decimals: the same number the server checks and reports. */
export function fileSizeMb(bytes: number): number {
  return Math.ceil((bytes / (1024 * 1024)) * 100) / 100;
}

export type FileCheck =
  | { ok: true }
  | { ok: false; reason: 'type'; message: string }
  | { ok: false; reason: 'size'; limit: LocalPlanLimit };

/**
 * Checks done before sending, to save a wasted upload. The server stays authoritative (it checks the type by
 * content and enforces every limit).
 */
export function checkFile(file: File, limits: PlanLimits): FileCheck {
  const name = file.name.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return {
      ok: false,
      reason: 'type',
      message: `“${file.name}” is not a CSV, TXT or Excel (.xlsx) file. Export it in one of those formats and try again.`,
    };
  }
  if (file.size === 0) {
    return { ok: false, reason: 'type', message: `“${file.name}” is empty.` };
  }
  const sizeMb = fileSizeMb(file.size);
  if (sizeMb > limits.max_file_mb) {
    return {
      ok: false,
      reason: 'size',
      limit: {
        limit_key: 'max_file_mb',
        limit: limits.max_file_mb,
        used: sizeMb,
      },
    };
  }
  return { ok: true };
}
