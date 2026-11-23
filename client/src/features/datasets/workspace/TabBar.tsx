import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { cn } from '@/lib/utils';
import { tabPath, type WorkspaceTab } from './tabs';

export const tabId = (tab: WorkspaceTab) => `workspace-tab-${tab}`;
export const panelId = (tab: WorkspaceTab) => `workspace-panel-${tab}`;

interface TabBarProps {
  datasetId: string;
  tabs: ReadonlyArray<{ key: WorkspaceTab; label: string }>;
  active: WorkspaceTab;
  /** Extra content after a tab's label, such as the Quality score. */
  badges?: Partial<Record<WorkspaceTab, ReactNode>>;
}

/**
 * The workspace tabs: a real tablist. Each tab is a link to its own URL (so Back moves between tabs); the arrow keys,
 * Home and End move to a tab and open it. Scrolls sideways on narrow screens.
 */
export function TabBar({ datasetId, tabs, active, badges = {} }: TabBarProps) {
  const navigate = useNavigate();
  const refs = useRef(new Map<WorkspaceTab, HTMLAnchorElement>());

  const open = (tab: WorkspaceTab) => {
    refs.current.get(tab)?.focus();
    if (tab !== active) navigate(tabPath(datasetId, tab));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const at = tabs.findIndex((t) => t.key === active);
    const last = tabs.length - 1;
    const next =
      event.key === 'ArrowRight' ? (at === last ? 0 : at + 1)
      : event.key === 'ArrowLeft' ? (at === 0 ? last : at - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    open(tabs[next]!.key);
  };

  return (
    <div className="-mx-4 overflow-x-auto overflow-y-hidden border-b px-4 sm:mx-0 sm:px-0">
      <div role="tablist" aria-label="Parts of this file" className="flex min-w-max gap-1" onKeyDown={onKeyDown}>
        {tabs.map((t) => {
          const selected = t.key === active;
          return (
            <a
              key={t.key}
              ref={(el) => {
                if (el) refs.current.set(t.key, el);
                else refs.current.delete(t.key);
              }}
              id={tabId(t.key)}
              role="tab"
              href={tabPath(datasetId, t.key)}
              aria-selected={selected}
              aria-controls={panelId(t.key)}
              tabIndex={selected ? 0 : -1}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                open(t.key);
              }}
              className={cn(
                'relative inline-flex min-h-11 items-center gap-2 rounded-t-md px-4 text-sm font-medium outline-none',
                // Inset: the row hides overflow, so an outer ring would be cut off.
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                // The active tab: a 3px green underline on the bar's own border.
                selected
                  ? 'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-[3px] after:rounded-full after:bg-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
              {badges[t.key]}
            </a>
          );
        })}
      </div>
    </div>
  );
}
