import { useEffect, useSyncExternalStore } from 'react';

/**
 * Whether a game keeps the viewer from talking in the island's live room now (임포스터 between meetings, say): its
 * server drops what they say there, and the island's chat bar takes nothing. Each source says for itself; the room is
 * quiet while any one does. `ChatBar` (minihome/live.tsx) reads it.
 */
const sources = new Set<string>();
const listeners = new Set<() => void>();

function set(source: string, quiet: boolean) {
  const was = sources.size > 0;
  if (quiet) sources.add(source);
  else sources.delete(source);
  if (was !== sources.size > 0) for (const listener of [...listeners]) listener();
}

export const roomQuiet = {
  get: (): boolean => sources.size > 0,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  set,
};

/** Whether the island's live room is quiet for the viewer, re-rendering when it changes. */
export function useRoomQuiet(): boolean {
  return useSyncExternalStore(roomQuiet.subscribe, roomQuiet.get, roomQuiet.get);
}

/** Keeps the room quiet for `source` while the calling component is mounted with `quiet`. */
export function useQuietRoom(source: string, quiet: boolean): void {
  useEffect(() => {
    set(source, quiet);
    return () => set(source, false);
  }, [source, quiet]);
}
