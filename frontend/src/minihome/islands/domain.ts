import type { RuntimeDomainBinding } from 'gaesup-world';

import type { IslandId } from './types';

/** The island save's domain that says which kind of island it was made from, for its sky, rooms and arrival notes. */
export const ISLAND_DOMAIN = 'island';
export const DEFAULT_ISLAND: IslandId = 'forest';
export const ISLAND_IDS: readonly IslandId[] = ['forest', 'city', 'cafe', 'park', 'farm', 'beach', 'camp', 'winter'];

const isIslandId = (value: unknown): value is IslandId => typeof value === 'string' && (ISLAND_IDS as readonly string[]).includes(value);

/**
 * The kind a saved domain names. Islands saved before there were kinds were all made from the forest, and so is one
 * whose kind this version does not know (a newer one, after a rollback): it keeps its own ground and things either way.
 */
export function parseIsland(data: unknown): IslandId {
  if (!data || typeof data !== 'object') return DEFAULT_ISLAND;
  const template = (data as { template?: unknown }).template;
  return isIslandId(template) ? template : DEFAULT_ISLAND;
}

export type IslandStore = {
  getState: () => IslandId;
  subscribe: (listener: () => void) => () => void;
  /** Advances with every change, for the island's save. */
  revision: () => number;
  set: (id: IslandId) => void;
};

export function createIslandStore(initial: IslandId = DEFAULT_ISLAND): IslandStore {
  let island = initial;
  let revision = 0;
  const listeners = new Set<() => void>();
  return {
    getState: () => island,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revision: () => revision,
    set(id) {
      if (id === island) return;
      island = id;
      revision++;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** The island save's `island` domain over `store`. */
export function islandBinding(store: IslandStore): RuntimeDomainBinding {
  return {
    key: ISLAND_DOMAIN,
    serialize: () => ({ version: 1, template: store.getState() }),
    hydrate: (data) => store.set(parseIsland(data)),
    prepareHydrate: (data) => {
      const next = parseIsland(data);
      return () => store.set(next);
    },
    owned: true,
    revision: store.revision,
    reset: () => store.set(DEFAULT_ISLAND),
  };
}
