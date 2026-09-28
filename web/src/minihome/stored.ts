import { useEffect, useState } from 'react';

const KEY = (name: string) => `minihome:${name}`;

/** Reads a stored value; storage can be missing or blocked (private windows, previews). */
export function readStored<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(KEY(name));
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeStored(name: string, value: unknown): void {
  try {
    localStorage.setItem(KEY(name), JSON.stringify(value));
  } catch {
    // The page works without storage; the value just does not survive a reload.
  }
}

/** `useState` that survives reloads in this browser, for this viewer's own settings. */
export function useStored<T>(name: string, fallback: T) {
  const [value, setValue] = useState(() => readStored(name, fallback));
  useEffect(() => writeStored(name, value), [name, value]);
  return [value, setValue] as const;
}

/** A stable id for a signed-out browser, so its visits count once a day like a signed-in visitor's. */
export function visitorId(): string {
  const stored = readStored<string | null>('visitor', null);
  if (stored) return stored;
  const created = crypto.randomUUID();
  writeStored('visitor', created);
  return created;
}
