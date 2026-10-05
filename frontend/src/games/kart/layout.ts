import type { LayoutContext } from '../game';
import type { KartOptions } from './index';
import { MAX_BOTS, MAX_LAPS, MAX_RACERS, trackLayout } from './track';

/** Laps when the host sets none, and how many karts a lone host races. */
const LAPS = 3;
const ALONE_FIELD = 4;

/** The settings a lobby of `people` starts with: bots up to four karts, three laps. */
export function defaultOptions(people: number): KartOptions {
  return { bots: Math.max(0, Math.min(MAX_BOTS, ALONE_FIELD - people)), laps: LAPS };
}

/** The most bots beside `people`. */
export const botRoom = (people: number) => Math.max(0, Math.min(MAX_BOTS, MAX_RACERS - people));

/** The host's settings, checked: bots within what the server takes beside `people`, laps 1 to 5. */
export function optionsFor(options: unknown, people: number): KartOptions {
  const given = (options ?? {}) as Partial<KartOptions>;
  const fallback = defaultOptions(people);
  const room = botRoom(people);
  const bots = Number.isInteger(given.bots) ? Math.max(0, Math.min(room, given.bots!)) : Math.min(room, fallback.bots);
  const laps = Number.isInteger(given.laps) ? Math.max(1, Math.min(MAX_LAPS, given.laps!)) : fallback.laps;
  return { bots, laps };
}

/** The host's start: the fixed circuit (the same on every page) and the host's settings. */
export function kartLayout({ session, options }: Partial<Pick<LayoutContext, 'session' | 'options'>>) {
  const { bots, laps } = optionsFor(options, session?.players.length ?? 1);
  return trackLayout(laps, bots);
}
