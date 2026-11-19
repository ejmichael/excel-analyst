import type { DatasetStatus } from '@/api/types';

/** A tab of the file workspace; the URL is /datasets/:id/:tab. */
export type WorkspaceTab = 'data' | 'quality' | 'ask' | 'reports';

/**
 * The tabs in display order. Later parts add Dashboard (first) and Insights (between Quality and Ask):
 * one line each here, plus their panel.
 */
export const TABS: ReadonlyArray<{ key: WorkspaceTab; label: string }> = [
  { key: 'data', label: 'Data' },
  { key: 'ask', label: 'Ask' },
  { key: 'reports', label: 'Reports' },
];

export const DEFAULT_TAB: WorkspaceTab = 'ask';

/**
 * The tabs that make sense for a file in this status. A ready file has them all; an expired file keeps its earlier
 * answers and reports but has no rows to show or check. A file being read, or one that could not be read, has none.
 */
export function tabsFor(status: DatasetStatus): ReadonlyArray<{ key: WorkspaceTab; label: string }> {
  if (status === 'ready') return TABS;
  if (status === 'expired') return TABS.filter((t) => t.key === 'ask' || t.key === 'reports');
  return [];
}

/** The tab to open when the URL names none, or one this file does not have. */
export function defaultTabFor(status: DatasetStatus): WorkspaceTab | null {
  const tabs = tabsFor(status);
  return tabs.some((t) => t.key === DEFAULT_TAB) ? DEFAULT_TAB : (tabs[0]?.key ?? null);
}

export const tabPath = (id: string, tab: WorkspaceTab) => `/datasets/${id}/${tab}`;
