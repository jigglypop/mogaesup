import { useEffect, useState } from 'react';

const KEY = (name: string) => `minihome:${name}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads a stored value; storage can be missing or blocked (private windows, previews). A stored object fills in only
 * the keys it has over `fallback`, so settings added later (and keys of the wrong kind) take their defaults; a value of
 * another kind than the fallback is not taken at all.
 */
export function readStored<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(KEY(name));
    if (raw === null) return fallback;
    const stored: unknown = JSON.parse(raw);
    if (isRecord(fallback)) {
      if (!isRecord(stored)) return fallback;
      const merged: Record<string, unknown> = { ...fallback };
      for (const [key, value] of Object.entries(stored)) {
        if (!(key in fallback) || fallback[key] === undefined || typeof value === typeof fallback[key]) merged[key] = value;
      }
      return merged as T;
    }
    return fallback === null || stored === null || typeof stored === typeof fallback ? (stored as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(name: string, value: unknown): void {
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

/**
 * A random id: `crypto.randomUUID` where the page may use it (a secure context, a browser new enough), else the same
 * shape from random bytes or, failing those too, from `Math.random`.
 */
export function randomId(): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Not a secure context.
  }
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A stable id for a signed-out browser, so its visits count once a day like a signed-in visitor's. */
export function visitorId(): string {
  const stored = readStored<string | null>('visitor', null);
  if (stored) return stored;
  const created = randomId();
  writeStored('visitor', created);
  return created;
}
