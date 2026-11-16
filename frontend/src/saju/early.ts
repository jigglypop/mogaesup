import { homeApi, sajuApi } from '../api/endpoints';
import type { HomeView, SajuVillage } from '../api/types';

// What a 섬's page reads first, asked for as soon as the address and the viewer are known: while the page's own code,
// and the graphics library with it, is still arriving (some hundreds of kilobytes to fetch and compile), not after it.
// The page takes what was asked for here instead of asking again (see minihome's read).

/** A 섬 as the server sends it: the home, its village, and a visitor's own home. */
export type Answers = { view: Promise<HomeView>; village: Promise<SajuVillage>; mine: Promise<SajuVillage['saju']> | null };

/** How long an early read stands in for the page's own. */
const FRESH_MS = 10_000;

const early = new Map<string, { at: number; answers: Answers }>();
/** Whether the page's code has arrived: from then on the page asks for itself, at once. */
let arrived = false;

/** Says the page's code has arrived (see {@link askEarly}). */
export function pageArrived(): void {
  arrived = true;
}
const keyOf = (username: string, viewer: string | null) => `${username}\n${viewer ?? ''}`;

/** Asks the server for `username`'s 섬 as `viewer` (null signed out) sees it. */
export function ask(username: string, viewer: string | null): Answers {
  const own = viewer === username;
  return {
    view: own ? homeApi.mine() : homeApi.get(username),
    village: sajuApi.village(username),
    mine: viewer && !own ? sajuApi.village(viewer).then(({ saju }) => saju, () => null) : null,
  };
}

/** Asks early for the 섬 the page is about to read, while its code is still on its way (once, until taken or stale). */
export function askEarly(username: string, viewer: string | null): void {
  if (arrived) return;
  const key = keyOf(username, viewer);
  const known = early.get(key);
  if (known && Date.now() - known.at < FRESH_MS) return;
  const answers = ask(username, viewer);
  // A refusal is the page's to show when it takes the answers; asked for and never taken, it is nobody's.
  for (const answer of [answers.view, answers.village, answers.mine]) void answer?.catch(() => undefined);
  early.set(key, { at: Date.now(), answers });
}

/** The answers asked for early for this read, if they are fresh: taken once. */
export function takeEarly(username: string, viewer: string | null): Answers | null {
  const key = keyOf(username, viewer);
  const known = early.get(key);
  early.delete(key);
  return known && Date.now() - known.at < FRESH_MS ? known.answers : null;
}
