import type { LayoutContext } from '../game';
import type { Vec3 } from '../protocol';
import type { ImpostorOptions } from './index';
import { shipPlaces, type ShipPlaces } from './ship';

export const MAX_BOTS = 9;
export const MAX_PLAYERS = 15;
/** People and bots together. */
export const MIN_PLAYERS = 4;
/** A table of six when the host brings fewer people than four. */
const TABLE = 6;

export type ImpostorLayout = ShipPlaces & {
  bots: number;
  role: 'crew' | 'impostor' | null;
};

/** Distance on the ground. */
export const flat = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/** The settings a lobby of `people` starts with: bots up to a table of six when they are fewer than four. */
export function defaultOptions(people: number): ImpostorOptions {
  return { bots: people < MIN_PLAYERS ? Math.min(MAX_BOTS, TABLE - people) : 0, role: 'random' };
}

/** The host's settings, checked: bots within what the server takes beside `people`, a side only for someone alone. */
export function optionsFor(options: unknown, people: number): ImpostorOptions {
  const given = (options ?? {}) as Partial<ImpostorOptions>;
  const fallback = defaultOptions(people);
  const room = Math.max(0, Math.min(MAX_BOTS, MAX_PLAYERS - people));
  const bots = Number.isInteger(given.bots) ? Math.max(0, Math.min(room, given.bots!)) : Math.min(room, fallback.bots);
  const role = people === 1 && (given.role === 'crew' || given.role === 'impostor') ? given.role : 'random';
  return { bots, role };
}

/** The host's start: the ship's places (see ship.ts), and the host's settings for `people` of them. */
export function impostorLayout({ session, options }: Partial<Pick<LayoutContext, 'session' | 'options'>> = {}): ImpostorLayout {
  const settings = optionsFor(options, session?.players.length ?? 1);
  return { ...shipPlaces(), bots: settings.bots, role: settings.role === 'random' ? null : settings.role };
}
