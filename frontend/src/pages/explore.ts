import type { HomeSummary } from '../api/types';

/** Islands asked for at a time; the server gives at most 50. */
export const EXPLORE_PAGE = 24;
/** The longest search the server takes, in characters. */
export const SEARCH_MAX = 40;

/** What of the search box is asked of the server: no edges, no control characters, no longer than it takes. */
export function searchOf(text: string): string {
  return [...text.replace(/\p{Cc}+/gu, ' ').trim()].slice(0, SEARCH_MAX).join('').trim();
}

/** Where the next page starts: the last island's time, or nothing once a page comes up short (the end was reached). */
export function nextBefore(page: HomeSummary[]): string | null {
  return page.length >= EXPLORE_PAGE ? (page[page.length - 1]?.updatedAt ?? null) : null;
}

/** The islands after another page came in: each once, in the order the server gave them. */
export function appendHomes(listed: HomeSummary[], page: HomeSummary[]): HomeSummary[] {
  const seen = new Set(listed.map((home) => home.username));
  return [...listed, ...page.filter((home) => !seen.has(home.username))];
}
