import type { HomeSummary } from '../api/types';

/** Islands asked for at a time; the server gives at most 50. */
export const EXPLORE_PAGE = 24;
/** The longest search the server takes, in characters. */
export const SEARCH_MAX = 40;

/** What of the search box is asked of the server: no edges, no control characters, no longer than it takes. */
export function searchOf(text: string): string {
  return [...text.replace(/\p{Cc}+/gu, ' ').trim()].slice(0, SEARCH_MAX).join('').trim();
}

/** Where the next page starts: after the last island, by its time and (when the server gave it) its owner. */
export type ExploreCursor = { before: string; beforeId?: string };

/** The cursor after `page`'s last island, or nothing once a page comes up short (the end was reached). */
export function nextCursor(page: HomeSummary[]): ExploreCursor | null {
  const last = page.length >= EXPLORE_PAGE ? page[page.length - 1] : undefined;
  if (!last) return null;
  return last.ownerId ? { before: last.updatedAt, beforeId: last.ownerId } : { before: last.updatedAt };
}

/** The islands after another page came in: each once, in the order the server gave them. */
export function appendHomes(listed: HomeSummary[], page: HomeSummary[]): HomeSummary[] {
  const seen = new Set(listed.map((home) => home.username));
  return [...listed, ...page.filter((home) => !seen.has(home.username))];
}
