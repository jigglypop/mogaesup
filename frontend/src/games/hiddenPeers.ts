import { useEffect, useSyncExternalStore } from 'react';

/**
 * Live-room peers whose avatars the island does not draw (a ghost, say), by `client_id` (a session player's `peer`).
 * Each source sets its own list; the island hides the union. `LiveAvatars` (minihome/live.tsx) reads it.
 */
const lists = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();
let hidden: ReadonlySet<string> = new Set();

function update() {
  const next = new Set([...lists.values()].flat());
  if (next.size === hidden.size && [...next].every((id) => hidden.has(id))) return;
  hidden = next;
  for (const listener of [...listeners]) listener();
}

export const hiddenPeers = {
  /** The peers hidden now; a new set only when it changes. */
  get: (): ReadonlySet<string> => hidden,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Hides `ids` for `source`, in place of what it hid before; an empty list shows them again. */
  set(source: string, ids: Iterable<string>) {
    const list = [...new Set(ids)];
    if (list.length) lists.set(source, list);
    else lists.delete(source);
    update();
  },
  clear(source: string) {
    hiddenPeers.set(source, []);
  },
};

/** The hidden peers, re-rendering when they change. */
export function useHiddenPeers(): ReadonlySet<string> {
  return useSyncExternalStore(hiddenPeers.subscribe, hiddenPeers.get, hiddenPeers.get);
}

/** Hides these peers while the calling component is mounted with them; `source` names whose list it is. */
export function useHidePeers(source: string, ids: readonly (string | null | undefined)[]): void {
  const key = ids.filter((id): id is string => !!id).sort().join('\n');
  useEffect(() => {
    hiddenPeers.set(source, key ? key.split('\n') : []);
    return () => hiddenPeers.clear(source);
  }, [source, key]);
}

/**
 * `players` without the hidden ones. The room's map is gaesup-world's live map, whose copies share their members'
 * latest states and subscriptions: the copy is made through its own class, and members are taken out of the copy alone
 * (the map's own `delete` would also drop the shared state the avatars left in it still read).
 */
export function withoutPeers<T>(players: ReadonlyMap<string, T>, ids: ReadonlySet<string>): ReadonlyMap<string, T> {
  if (![...ids].some((id) => players.has(id))) return players;
  const Copy = players.constructor as new (source: ReadonlyMap<string, T>) => Map<string, T>;
  const copy = new Copy(players);
  for (const id of ids) Map.prototype.delete.call(copy, id);
  return copy;
}
