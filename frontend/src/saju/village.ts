import type { Element } from './elements';

/** The firm ground of each home's island, between its banks, is this wide and deep in the map's metres. */
export const ISLAND = 10;
/** How far a neighbour's island stands from the middle one, centre to centre: a bridge's length of water between them. */
export const PLOT_REACH = 14;

/** How many 이웃 a member has when their village raises its flag: from then on the island with the flag stands in it. */
export const FLAG_NEIGHBOURS = 10;
export const flagRaised = (neighbours: number) => neighbours >= FLAG_NEIGHBOURS;
/**
 * Where the flag's island lies: out past the east plot. Seen from the south-east the nine plots make a diamond, and
 * this is the corner of the picture the diamond leaves open, so a full village is framed no wider for it.
 */
export const FLAG_SPOT = { x: 27, z: 0 } as const;

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
    .map(([slot, id]) => ({ id, x: SLOTS[slot]!.x * PLOT_REACH, z: SLOTS[slot]!.z * PLOT_REACH }));
}
