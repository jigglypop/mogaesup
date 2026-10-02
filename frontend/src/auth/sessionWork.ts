/** Work kept after navigation still belongs to the session that started it. */
let owner: string | null | undefined;
const work = new Map<() => void, string>();

export function setSessionOwner(next: string | null): void {
  owner = next;
  for (const [stop, expected] of [...work]) {
    if (expected === next) continue;
    work.delete(stop);
    stop();
  }
}

export const sessionBelongsTo = (expected: string) => owner === expected;

export function followSessionOwner(expected: string, stop: () => void): () => void {
  if (owner !== undefined && owner !== expected) {
    stop();
    return () => {};
  }
  work.set(stop, expected);
  return () => { work.delete(stop); };
}
