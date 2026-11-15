import { WATER_LEVEL } from '../mood';

// Where the lake meets the islands. Every island's waterline runs round a rounded square about its middle, and its bank
// falls through it from the lawn to the lake's bed. From those shapes alone (no picture of the depths is drawn) every
// point of the lake knows how far it is from the nearest shore and how deep the water is there: where the swell calms,
// where the shallows lighten and where the waves break.

/**
 * An island as the lake sees it: its middle, the half-size and corner radius of the rounded square its waterline runs
 * round, and how far from its middle its ground reaches under the water on a straight side (terrain's IslandShape).
 */
export type OceanIsland = { x: number; z: number; half: number; corner: number; reach: number };

/** The lake's bed at the foot of an island's bank, and how far inside and outside the waterline's square the bank begins and ends (terrain's Site.height). */
export const BED = -1.5;
const LAWN_INSIDE = 0.5;
const BED_OUTSIDE = 1.5;
/** At most this many islands are shaded; a village has its own, ten 이웃 and the flag's. */
export const MAX_ISLANDS = 16;

const smooth = (from: number, to: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/** How far outside the rounded square of `island`'s waterline (x, z) lies, in metres; negative inside it. */
export function outside(island: OceanIsland, x: number, z: number): number {
  const corner = Math.min(island.corner, island.half);
  const straight = island.half - corner;
  const qx = Math.abs(x - island.x) - straight;
  const qz = Math.abs(z - island.z) - straight;
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - corner;
}

/** The ground's height `out` metres outside a waterline's square: the lawn's well inside it, the bed's well outside, smooth between. */
export function bankHeight(out: number): number {
  return BED - BED * smooth(-BED_OUTSIDE, LAWN_INSIDE, -out);
}

/** The bank's two ends, as `out` runs: where the lawn stops and where the bed begins. */
export const BANK = { lawn: -LAWN_INSIDE, bed: BED_OUTSIDE } as const;

/** How far outside the square the bank has come down to the water: the true waterline, a few centimetres out. */
export const WATERLINE = (() => {
  let low = -LAWN_INSIDE;
  let high = BED_OUTSIDE;
  for (let step = 0; step < 50; step++) {
    const middle = (low + high) / 2;
    if (bankHeight(middle) > WATER_LEVEL) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
})();

/** What the lake knows at a point: how far out from the nearest waterline it lies (negative ashore), and how deep it is there. */
export type Shore = { distance: number; depth: number };

/** The nearest shore to (x, z) among `islands`, and the water's depth there; far from every island, the open lake's own. */
export function shoreAt(islands: readonly OceanIsland[], x: number, z: number): Shore {
  let out = Infinity;
  for (const island of islands) out = Math.min(out, outside(island, x, z));
  if (out === Infinity) return { distance: Infinity, depth: WATER_LEVEL - BED };
  return { distance: out - WATERLINE, depth: WATER_LEVEL - bankHeight(out) };
}

/** How high the water may rise above its rest right at the shore: a hand's breadth up the bank, never near the lawn. */
export const SHORE_CREST = 0.1;
/** And out in the open lake, where nothing stands to be wetted. */
export const OPEN_CREST = 0.22;
/** How far out from the shore the swell is free of it. */
export const SHORE_CALM = 6;

/** How high above its rest the water may rise `distance` metres out from the nearest shore. */
export function crestLimit(distance: number): number {
  return SHORE_CREST + (OPEN_CREST - SHORE_CREST) * smooth(0, SHORE_CALM, distance);
}

/**
 * A crest `height` above the water's rest, held under `limit`: low ones as they are, high ones pressed ever closer to the
 * limit without reaching it, so a crest rounds over instead of being cut flat. Troughs are left as they are.
 */
export function limitCrest(height: number, limit: number): number {
  return height <= 0 ? height : limit * (1 - Math.exp(-height / limit));
}

/** How much of the swell is left `distance` metres from the shore: a little at the waterline, all of it out in the lake, none in a pond. */
export function swellShare(distance: number): number {
  return smooth(-0.6, 0, distance) * (0.3 + 0.7 * smooth(0, SHORE_CALM, distance));
}
