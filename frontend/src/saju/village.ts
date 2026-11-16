import type { Element } from './elements';
import { ISLANDS, shoreAt } from './scene/terrain';

/** The firm ground of a neighbour's island, between its banks, is this wide and deep in the map's metres. */
export const ISLAND = 10;
/** The water a bridge spans between the middle island and a neighbour's, waterline to waterline, before the lines wander. */
const BRIDGE_WATER = 3;
/**
 * How far a neighbour's island stands from the middle one, centre to centre, on one of the four sides: the middle
 * island's shore, a bridge's length of water, and the neighbour's shore.
 */
export const PLOT_REACH = ISLANDS.home.half + BRIDGE_WATER + ISLANDS.neighbour.half;
/**
 * How far east or west, and north or south, a neighbour's island at a corner stands from the middle one. The middle
 * island, an estate, is as round at its corners as its coast, so a corner's neighbour comes in from the square's
 * corner until the same bridge's length of water lies between them: the eight stand in a ring about it.
 */
export const CORNER_REACH = (shoreAt(ISLANDS.home, Math.PI / 4) + BRIDGE_WATER + shoreAt(ISLANDS.neighbour, Math.PI / 4)) / Math.SQRT2;

/** How many 이웃 a member has when their village raises its flag: from then on the island with the flag stands in it. */
export const FLAG_NEIGHBOURS = 10;
export const flagRaised = (neighbours: number) => neighbours >= FLAG_NEIGHBOURS;
/**
 * Where the flag's island lies: out past the east plot, as much water between them as between two homes' islands and
 * a little more. Seen from the south-east the ring of plots makes a diamond, and this is the corner of the picture the
 * diamond leaves open, so a full village is framed no wider for it. In the picture its mast stands below the north-east
 * home's island, far enough toward the viewer that the finial ends under that island's shore and not against it.
 */
export const FLAG_SPOT = { x: PLOT_REACH + 13.4, z: 0.4 } as const;

/** A place for a home on the village map. */
export type Plot = {
  /** The resident living there. */
  id: string;
  x: number;
  z: number;
};

/**
 * Where neighbours go, in the order they are taken: the four sides first, then the corners. The sides are the five
 * elements' own directions (오방): 목 east, 화 south, 금 west, 수 north; the middle, 토's, is the viewer's own plot.
 */
const SLOTS: readonly { x: number; z: number }[] = [
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 0, z: -1 },
  { x: 1, z: 1 },
  { x: -1, z: 1 },
  { x: -1, z: -1 },
  { x: 1, z: -1 },
];
/** The slot each element asks for first. 토 has no side of its own and takes the first one left. */
const HOME_SLOT: Partial<Record<Element, number>> = { wood: 0, fire: 1, metal: 2, water: 3 };

/**
 * Plots for the village's neighbours around the middle one, which is the viewer's (or stands empty until they move in).
 * Each neighbour gets its element's side while it is free, else the next free slot.
 */
export function plotsOf(neighbours: readonly { id: string; element: Element }[]): Plot[] {
  const taken = new Map<number, string>();
  const waiting: string[] = [];
  for (const { id, element } of neighbours) {
    const wanted = HOME_SLOT[element];
    if (wanted !== undefined && !taken.has(wanted)) taken.set(wanted, id);
    else waiting.push(id);
  }
  for (const id of waiting) {
    const free = SLOTS.findIndex((_, index) => !taken.has(index));
    if (free < 0) break;
    taken.set(free, id);
  }
  return [...taken.entries()]
    .sort(([a], [b]) => a - b)
    .map(([slot, id]) => {
      const { x, z } = SLOTS[slot]!;
      const reach = x !== 0 && z !== 0 ? CORNER_REACH : PLOT_REACH;
      return { id, x: x * reach, z: z * reach };
    });
}

/** How far a bridge's foot reaches up onto the bank past the waterline, at either end. */
const BRIDGE_FOOT = 0.75;

/**
 * The bridge from the middle island (`from`) to a neighbour's (`to`), their centres on the ground: where its middle
 * lies and how long it is, from a foot on one bank to a foot on the other. The middle island is the larger, so the
 * bridge's middle lies past the halfway point between the two centres, over the middle of the water.
 */
export function bridgeSpan(from: { x: number; z: number }, to: { x: number; z: number }): { middle: [number, number]; length: number } {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const apart = Math.hypot(dx, dz);
  const bearing = Math.atan2(dz, dx);
  const start = shoreAt(ISLANDS.home, bearing) - BRIDGE_FOOT;
  const end = apart - (shoreAt(ISLANDS.neighbour, bearing + Math.PI) - BRIDGE_FOOT);
  const along = (start + end) / 2 / (apart || 1);
  return { middle: [from.x + dx * along, from.z + dz * along], length: end - start };
}
