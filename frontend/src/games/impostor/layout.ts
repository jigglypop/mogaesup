import type { LayoutContext } from '../game';
import type { Vec3 } from '../protocol';
import { openSpots } from '../spots';
import type { ImpostorOptions } from './index';

/** As the server takes them (server/src/games/impostor/mod.rs). */
const MIN_STATIONS = 6;
const MAX_STATIONS = 12;
const MAX_VENTS = 8;
export const MAX_BOTS = 9;
export const MAX_PLAYERS = 15;
/** People and bots together. */
export const MIN_PLAYERS = 4;
/** The most open spots the bots walk between. */
const MAX_WALK = 400;
/** How far apart stations stand where the island has room, then as near as it must (the server keeps 3.6 m). */
const GAPS = [6, 4];
/** Vents: this many where the island has room, this far from the table, the stations and one another. */
const VENTS = 4;
const VENT_GAP = 5;
/** The table is one of this many open spots nearest the host. */
const TABLE_CHOICES = 9;
/** Open spots this near the table leave room around it for the seats. */
const ROOM = 4.5;
/** A table of six when the host brings fewer people than four. */
const TABLE = 6;

const FEW = '작업 자리가 부족해요.';

export type ImpostorLayout = {
  stations: Vec3[];
  table: Vec3;
  vents: Vec3[];
  walk: Vec3[];
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

/** The middle of the spots' extent: the island's centre as far as the game is concerned. */
function middle(open: readonly Vec3[]): Vec3 {
  const xs = open.map((spot) => spot[0]);
  const zs = open.map((spot) => spot[2]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2];
}

/** Of the open spots nearest `anchor`, the one with the most open spots around it (the nearest of those). */
function tableSpot(open: readonly Vec3[], anchor: Vec3): Vec3 {
  const nearest = [...open].sort((a, b) => flat(a, anchor) - flat(b, anchor)).slice(0, TABLE_CHOICES);
  const room = (spot: Vec3) => open.filter((other) => other !== spot && flat(other, spot) <= ROOM).length;
  return nearest.reduce((best, spot) => (room(spot) > room(best) ? spot : best));
}

/** Up to `most` spots, each the farthest from `taken` and those chosen before it, while that is at least `gap`. */
function spread(open: readonly Vec3[], taken: readonly Vec3[], gap: number, most: number): Vec3[] {
  const chosen: Vec3[] = [];
  // How far each spot is from everything taken so far.
  const clear = open.map((spot) => Math.min(...taken.map((place) => flat(spot, place))));
  while (chosen.length < most) {
    let best = -1;
    clear.forEach((away, index) => {
      if (away >= gap && (best < 0 || away > clear[best]!)) best = index;
    });
    if (best < 0) break;
    const place = open[best]!;
    chosen.push(place);
    clear.forEach((away, index) => {
      clear[index] = Math.min(away, flat(open[index]!, place));
    });
  }
  return chosen;
}

/**
 * The host's start: the meeting table on an open spot near the host (or the island's middle) with room around it, six to
 * twelve stations spread over the island at least 6 m apart where it has room, up to four vents away from both, the
 * open spots the bots walk between, and the host's settings.
 */
export function impostorLayout({ building, spots, position, session, options }: Pick<LayoutContext, 'spots' | 'position'> &
  Partial<Pick<LayoutContext, 'building' | 'session' | 'options'>>): ImpostorLayout {
  const open = spots();
  if (open.length <= MIN_STATIONS) throw new Error(FEW);
  const table = tableSpot(open, position ?? middle(open));
  for (const gap of GAPS) {
    const stations = spread(open, [table], gap, MAX_STATIONS);
    if (stations.length < MIN_STATIONS) continue;
    const vents = spread(open, [table, ...stations], VENT_GAP, Math.min(VENTS, MAX_VENTS));
    const walk = building ? openSpots(building, { limit: MAX_WALK }) : open;
    const settings = optionsFor(options, session?.players.length ?? 1);
    return { stations, table, vents: vents.length >= 2 ? vents : [], walk, bots: settings.bots, role: settings.role === 'random' ? null : settings.role };
  }
  throw new Error(FEW);
}
