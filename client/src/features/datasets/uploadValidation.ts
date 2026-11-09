import type { PlanLimits } from '@/api/types';
import type { LocalPlanLimit } from '@/components/UpgradeDialog';

export const ACCEPTED_EXTENSIONS = ['.csv', '.txt', '.xlsx'] as const;
export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(',');

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
  if (file.size > limits.max_file_mb * 1024 * 1024) {
    return {
      ok: false,
      reason: 'size',
      limit: {
        limit_key: 'max_file_mb',
        limit: limits.max_file_mb,
        // Rounded up so a 5.2 MB file never reads as "5 MB" against a 5 MB limit.
        used: Math.ceil((file.size / (1024 * 1024)) * 10) / 10,
      },
    };
  }
  return { ok: true };
}
