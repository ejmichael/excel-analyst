import { useSyncExternalStore } from 'react';
import type { AutoReportRequest, ID } from '@/api/types';

/**
 * The "Build my report" run started from each dataset, so coming back to the dataset page shows the same progress
 * or the result. Kept in sessionStorage; when storage is unavailable (private mode, blocked site data) it lives in
 * memory for this tab.
 */
export interface StoredRun {
  run_id: ID;
  /** What was sent, so "Try again" can send the same. */
  request: AutoReportRequest;
  /** When it was started (epoch ms): the 3-minute "taking longer" notice counts from here, across visits. */
  started_at: number;
}

const KEY_PREFIX = 'analyst.auto-report.';
const memory = new Map<ID, StoredRun | null>();
const listeners = new Set<() => void>();

function isStoredRun(value: unknown): value is StoredRun {
  if (!value || typeof value !== 'object') return false;
  const v = value as StoredRun;
  return typeof v.run_id === 'string' && typeof v.started_at === 'number' && !!v.request && typeof v.request === 'object';
}

function read(datasetId: ID): StoredRun | null {
  if (memory.has(datasetId)) return memory.get(datasetId) ?? null;
  let run: StoredRun | null = null;
  try {
    const raw = window.sessionStorage.getItem(KEY_PREFIX + datasetId);
    const parsed = raw === null ? null : (JSON.parse(raw) as unknown);
    run = isStoredRun(parsed) ? parsed : null;
  } catch {
    // Storage unavailable or damaged: nothing remembered.
  }
  memory.set(datasetId, run);
  return run;
}

function write(datasetId: ID, run: StoredRun | null): void {
  memory.set(datasetId, run);
  try {
    if (run) window.sessionStorage.setItem(KEY_PREFIX + datasetId, JSON.stringify(run));
    else window.sessionStorage.removeItem(KEY_PREFIX + datasetId);
  } catch {
    // Not fatal: held in memory for this tab.
  }
  listeners.forEach((l) => l());
}

export const runStore = {
  get: read,
  set: (datasetId: ID, run: StoredRun) => write(datasetId, run),
  clear: (datasetId: ID) => write(datasetId, null),
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** For tests: forget the in-memory copy (as after a reload). */
  resetMemory(): void {
    memory.clear();
  },
};

/** The run remembered for one dataset, live. */
export function useStoredRun(datasetId: ID): StoredRun | null {
  return useSyncExternalStore(runStore.subscribe, () => runStore.get(datasetId), () => null);
}
