/** Screens holding edits a move to another page could lose (see `onLeaving`). */
const takers = new Set<(to: string) => boolean>();

/**
 * Goes to `to` with `go`, unless a screen holding edits takes the move over: it then asks, saves or stays, and makes the
 * move itself. For moves that are not a link (the search box); links are caught as they are clicked.
 */
export function leaveFor(to: string, go: (to: string) => void): void {
  for (const take of [...takers]) {
    if (take(to)) return;
  }
  go(to);
}

/** `take` hears each `leaveFor` first and answers whether it took the move over; returns the stop for it. */
export function onLeaving(take: (to: string) => boolean): () => void {
  takers.add(take);
  return () => {
    takers.delete(take);
  };
}
