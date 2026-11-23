import type { DatasetStatus } from '@/api/types';

/** A tab of the file workspace; the URL is /datasets/:id/:tab. */
export type WorkspaceTab = 'dashboard' | 'data' | 'quality' | 'ask' | 'reports';

/** The tabs in display order. A later part adds Insights (between Quality and Ask): one line here, plus its panel. */
export const TABS: ReadonlyArray<{ key: WorkspaceTab; label: string }> = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'data', label: 'Data' },
  { key: 'quality', label: 'Quality' },
  { key: 'ask', label: 'Ask' },
  { key: 'reports', label: 'Reports' },
];

export const DEFAULT_TAB: WorkspaceTab = 'dashboard';

/**
 * The tabs that make sense for a file in this status. A ready file has them all; an expired file keeps its earlier
 * answers and reports but has no rows to show, check or chart. A file being read, or one that could not be read, has none.
 */
export function tabsFor(status: DatasetStatus): ReadonlyArray<{ key: WorkspaceTab; label: string }> {
  if (status === 'ready') return TABS;
  if (status === 'expired') return TABS.filter((t) => t.key === 'ask' || t.key === 'reports');
  return [];
}

/**
 * The tab to open when the URL names none, or one this file does not have. An older link with ?q= (a suggested
 * question) opens Ask, which still asks it.
 */
export function defaultTabFor(status: DatasetStatus, { question = false } = {}): WorkspaceTab | null {
  const tabs = tabsFor(status);
  const wanted: WorkspaceTab = question ? 'ask' : DEFAULT_TAB;
  if (tabs.some((t) => t.key === wanted)) return wanted;
  return tabs.some((t) => t.key === 'ask') ? 'ask' : (tabs[0]?.key ?? null);
}

export const tabPath = (id: string, tab: WorkspaceTab) => `/datasets/${id}/${tab}`;
