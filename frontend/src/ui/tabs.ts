import { useId, type KeyboardEvent } from 'react';

/** Which tab an arrow, Home or End key moves to from `index` among `count` tabs, or null for any other key. */
export function nextTabIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * A tablist's wiring (the WAI-ARIA tabs pattern): one tab in the Tab order, arrow keys and Home/End move between the tabs
 * and select as they go, and each tab names the panel it shows. Spread `list` on the tablist, `tab(id)` on each tab and
 * `panel(id)` on each panel; a panel that is not selected is `hidden`, so it keeps what was typed in it.
 */
export function useTabs<T extends string>(ids: readonly T[], selected: T, select: (id: T) => void) {
  const base = useId();
  const tabId = (id: T) => `${base}tab-${id}`;
  const panelId = (id: T) => `${base}panel-${id}`;
  return {
    list: {
      role: 'tablist' as const,
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        const next = nextTabIndex(event.key, Math.max(0, ids.indexOf(selected)), ids.length);
        if (next === null) return;
        // The world and the editors listen for arrows too; inside the tablist they only move between tabs.
        event.preventDefault();
        event.stopPropagation();
        const id = ids[next]!;
        select(id);
        document.getElementById(tabId(id))?.focus();
      },
    },
    tab: (id: T) => ({
      role: 'tab' as const,
      id: tabId(id),
      'aria-selected': id === selected,
      'aria-controls': panelId(id),
      tabIndex: id === selected ? 0 : -1,
      onClick: () => select(id),
    }),
    panel: (id: T) => ({
      role: 'tabpanel' as const,
      id: panelId(id),
      'aria-labelledby': tabId(id),
      hidden: id !== selected,
      tabIndex: 0,
    }),
  };
}
