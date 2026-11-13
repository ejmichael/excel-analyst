import { useCallback, useSyncExternalStore } from 'react';
import type { ID } from '@/api/types';

/**
 * The report tray: answers picked for a new report, per workspace. Kept in sessionStorage so it survives
 * navigation and reloads; when storage is unavailable (private mode, blocked site data) it lives in memory.
 */

export const MAX_REPORT_BLOCKS = 30;

export interface TrayItem {
  block_id: ID;
  title: string;
  dataset_id: ID | null;
  dataset_name: string | null;
}

const KEY_PREFIX = 'analyst.report-tray.';
const memory = new Map<ID, TrayItem[]>();
const listeners = new Set<() => void>();
const EMPTY: TrayItem[] = [];

function read(workspaceId: ID): TrayItem[] {
  try {
    const raw = window.sessionStorage.getItem(KEY_PREFIX + workspaceId);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const items = parsed.filter(
          (i): i is TrayItem => !!i && typeof i === 'object' && typeof (i as TrayItem).block_id === 'string',
        );
        memory.set(workspaceId, items.slice(0, MAX_REPORT_BLOCKS));
      }
    }
  } catch {
    // Storage unavailable: memory is the source.
  }
  return memory.get(workspaceId) ?? EMPTY;
}

function write(workspaceId: ID, items: TrayItem[]): void {
  memory.set(workspaceId, items);
  try {
    if (items.length === 0) window.sessionStorage.removeItem(KEY_PREFIX + workspaceId);
    else window.sessionStorage.setItem(KEY_PREFIX + workspaceId, JSON.stringify(items));
  } catch {
    // Not fatal: held in memory for this tab.
  }
  listeners.forEach((l) => l());
}

/** Snapshots are cached per workspace so useSyncExternalStore sees a stable value between changes. */
const snapshots = new Map<ID, TrayItem[]>();
function snapshot(workspaceId: ID): TrayItem[] {
  const current = memory.get(workspaceId) ?? read(workspaceId);
  if (snapshots.get(workspaceId) !== current) snapshots.set(workspaceId, current);
  return snapshots.get(workspaceId)!;
}

export const trayStore = {
  get: (workspaceId: ID): TrayItem[] => snapshot(workspaceId),
  /** Adds at the end. Returns false if it was already there or the tray is full. */
  add(workspaceId: ID, item: TrayItem): boolean {
    const items = snapshot(workspaceId);
    if (items.some((i) => i.block_id === item.block_id) || items.length >= MAX_REPORT_BLOCKS) return false;
    write(workspaceId, [...items, item]);
    return true;
  },
  remove(workspaceId: ID, blockIds: ID | ID[]): void {
    const drop = new Set(Array.isArray(blockIds) ? blockIds : [blockIds]);
    write(workspaceId, snapshot(workspaceId).filter((i) => !drop.has(i.block_id)));
  },
  /** Moves an item one place up (-1) or down (+1). */
  move(workspaceId: ID, blockId: ID, direction: -1 | 1): void {
    const items = [...snapshot(workspaceId)];
    const from = items.findIndex((i) => i.block_id === blockId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= items.length) return;
    [items[from], items[to]] = [items[to]!, items[from]!];
    write(workspaceId, items);
  },
  clear(workspaceId: ID): void {
    write(workspaceId, []);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** For tests: forget the in-memory copy (as after a reload). */
  resetMemory(): void {
    memory.clear();
    snapshots.clear();
  },
};

/** The tray of one workspace, live. */
export function useReportTray(workspaceId: ID | undefined) {
  const items = useSyncExternalStore(
    trayStore.subscribe,
    () => (workspaceId ? trayStore.get(workspaceId) : EMPTY),
    () => EMPTY,
  );
  const has = useCallback((blockId: ID) => items.some((i) => i.block_id === blockId), [items]);
  return {
    items,
    has,
    full: items.length >= MAX_REPORT_BLOCKS,
    add: (item: TrayItem) => (workspaceId ? trayStore.add(workspaceId, item) : false),
    remove: (blockIds: ID | ID[]) => workspaceId && trayStore.remove(workspaceId, blockIds),
    move: (blockId: ID, direction: -1 | 1) => workspaceId && trayStore.move(workspaceId, blockId, direction),
    clear: () => workspaceId && trayStore.clear(workspaceId),
  };
}
