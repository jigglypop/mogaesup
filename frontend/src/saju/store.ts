import { useSyncExternalStore } from 'react';

import { randomId } from '../minihome/stored';
import { isValidBirthDate, type Birth } from './engine';
import {
  ENTRY_MAX,
  MY_HOME,
  NAME_MAX,
  SAMPLE_RESIDENTS,
  sampleOf,
  SEED_ENTRIES,
  WELCOME_NOTES,
  type GuestEntry,
  type Resident,
} from './residents';

// The village lives in this browser: the viewer's own home, the lines they wrote or were left, and the bridges they
// built are kept in its storage, beside the sample residents every visitor meets. Nothing here is sent anywhere.

export type SajuState = {
  /** The viewer's own home, once they have built one. */
  me: Resident | null;
  /** Guestbook lines written in this browser (the samples' own are in SEED_ENTRIES). */
  entries: GuestEntry[];
  /** Homes the viewer has built a bridge to. */
  bridges: string[];
};

const KEY = 'saju:village';
const EMPTY: SajuState = { me: null, entries: [], bridges: [] };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function birthOf(value: unknown): Birth | null {
  if (!isRecord(value)) return null;
  const { calendar, year, month, day, leapMonth, time, gender } = value;
  if (calendar !== 'solar' && calendar !== 'lunar') return null;
  if (gender !== 'female' && gender !== 'male') return null;
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number' || typeof leapMonth !== 'boolean') return null;
  if (time !== null && (typeof time !== 'string' || !TIME.test(time))) return null;
  const birth: Birth = { calendar, year, month, day, leapMonth: calendar === 'lunar' && leapMonth, time, gender };
  return isValidBirthDate(birth) ? birth : null;
}

function entryOf(value: unknown): GuestEntry | null {
  if (!isRecord(value)) return null;
  const { id, home, author, name, body, at } = value;
  if (![id, home, author, name, body, at].every((field) => typeof field === 'string' && field !== '')) return null;
  if ((body as string).length > ENTRY_MAX || Number.isNaN(Date.parse(at as string))) return null;
  return { id, home, author, name, body, at } as GuestEntry;
}

/** What storage holds, with anything that is not this shape left out: storage is the viewer's to edit, or another version's. */
export function parseState(raw: string | null): SajuState {
  if (!raw) return EMPTY;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (!isRecord(stored)) return EMPTY;
  const birth = isRecord(stored['me']) ? birthOf(stored['me']['birth']) : null;
  const name = isRecord(stored['me']) && typeof stored['me']['name'] === 'string' ? stored['me']['name'].trim().slice(0, NAME_MAX) : '';
  const me = birth && name ? { id: MY_HOME, name, birth, sample: false } : null;
  const entries = Array.isArray(stored['entries']) ? stored['entries'].flatMap((entry) => entryOf(entry) ?? []) : [];
  const bridges = Array.isArray(stored['bridges']) ? [...new Set(stored['bridges'].filter((id): id is string => typeof id === 'string' && !!sampleOf(id)))] : [];
  // Without a home there is nobody to have written a line or built a bridge.
  return me ? { me, entries, bridges } : EMPTY;
}

function read(): SajuState {
  try {
    return parseState(localStorage.getItem(KEY));
  } catch {
    return EMPTY;
  }
}

let state = read();
const listeners = new Set<() => void>();

function commit(next: SajuState): void {
  state = next;
  try {
    if (next.me) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    // A private window may refuse storage; the village then lasts as long as the page.
  }
  for (const listener of listeners) listener();
}

/** Another tab of this browser moved in, wrote or built a bridge (a null key: storage was cleared). */
function otherTabChanged(event: StorageEvent): void {
  if (event.key !== KEY && event.key !== null) return;
  state = read();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('storage', otherTabChanged);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', otherTabChanged);
  };
}

export const sajuStore = {
  getState: () => state,
  subscribe,
  /** Builds the viewer's home, or rebuilds it for a corrected name or birth. A new home gets its neighbours' welcome. */
  moveIn(name: string, birth: Birth, now: Date = new Date()): void {
    const me: Resident = { id: MY_HOME, name: name.trim().slice(0, NAME_MAX), birth, sample: false };
    if (state.me) {
      commit({ ...state, me });
      return;
    }
    const welcome = WELCOME_NOTES.flatMap((note, index) => {
      const author = sampleOf(note.author);
      // A minute apart, the first the latest, so they keep their order under the newest-first guestbook.
      return author ? [{ id: randomId(), home: MY_HOME, author: author.id, name: author.name, body: note.body, at: new Date(now.getTime() - index * 60_000).toISOString() }] : [];
    });
    commit({ me, entries: welcome, bridges: [] });
  },
  /** Takes the viewer's home down, with everything this browser kept for it. */
  moveOut(): void {
    commit(EMPTY);
  },
  /** Leaves a line in `home`'s guestbook as the viewer. Nothing is written without a home of one's own or without words. */
  write(home: string, body: string, now: Date = new Date()): void {
    const text = body.trim().slice(0, ENTRY_MAX);
    if (!state.me || !text) return;
    commit({ ...state, entries: [...state.entries, { id: randomId(), home, author: MY_HOME, name: state.me.name, body: text, at: now.toISOString() }] });
  },
  /** Removes a line the viewer may remove (see {@link canErase}). */
  erase(id: string): void {
    const entry = state.entries.find((item) => item.id === id);
    if (!entry || !canErase(entry)) return;
    commit({ ...state, entries: state.entries.filter((item) => item.id !== id) });
  },
  /** Builds the bridge from the viewer's home to a neighbour's. */
  connect(home: string): void {
    if (!state.me || !sampleOf(home) || state.bridges.includes(home)) return;
    commit({ ...state, bridges: [...state.bridges, home] });
  },
};

/** One's own lines anywhere, and any line in one's own guestbook. */
export function canErase(entry: GuestEntry): boolean {
  return entry.author === MY_HOME || entry.home === MY_HOME;
}

/** The village as this browser has it; re-renders when it changes, here or in another tab. */
export function useSaju(): SajuState {
  return useSyncExternalStore(subscribe, sajuStore.getState, sajuStore.getState);
}

/** Everyone in the village: the viewer (`me`, once they have a home) first, then the samples. */
export function residentsOf(me: Resident | null): Resident[] {
  return me ? [me, ...SAMPLE_RESIDENTS] : [...SAMPLE_RESIDENTS];
}

/** A home's guestbook, newest first. */
export function entriesOf(current: SajuState, home: string): GuestEntry[] {
  return [...current.entries, ...SEED_ENTRIES]
    .filter((entry) => entry.home === home)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** For tests: forgets what was read from storage. */
export function resetSajuStore(): void {
  state = read();
  for (const listener of listeners) listener();
}
