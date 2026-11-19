import { bench, boat, barrel, fence, jetty, lantern, parasol, pot, tableSet } from './arch';
import { Builder, type Build, type Finish, type V3 } from './build';
import { WATER_LEVEL } from './mood';
import { hash } from './noise';
import { bush, flowerBed, lilies, pine, rock, tree, type Palette } from './plants';
import { dressShore, ground, Site, type GroundLook, type IslandShape } from './terrain';

// 공용섬: a harbour island where many people come together, owned by the one who raised it. A broad round island with
// a paved square in its middle under one great tree, benches about it and a café's tables under parasols on one side,
// a row of market stalls on the other, a notice board at the square's edge; to the south, toward the camera, a quay of
// planks runs along the shore with three piers out over the water and boats made fast to them, crates and barrels on the
// boards and lamps along the edge. Pines close the island in to the north, as a harbour's hill does.

const TAU = Math.PI * 2;
const QUARTER = Math.PI / 2;
const SEED = 211;
/** From the island's middle to its shoreline on a straight side, and how round its corners are. */
const HALF = 17;
/** The island's ground as the lake meets it (see terrain's IslandShape). */
export const HARBOR_ISLAND: IslandShape = { half: HALF, corner: 11, reach: HALF + 2 };
const LOOK: GroundLook = {
  lawn: ['#6f9d4c', '#83b15a', '#9cc06a'],
  dirt: '#8a6d4c',
  bank: '#a99f8c',
  sand: '#d8c49a',
  yard: '#c9b48c',
  rocks: ['#9d988c', '#aea99c', '#8a867c'],
};
const STONE: Finish = { surface: 'stone', rough: 0.88 };
const PAVING: Finish = { surface: 'masonry', rough: 0.9, shadowless: true, vary: 0.05 };
const WOOD: Finish = { surface: 'wood', rough: 0.82, vary: 0.1 };
const CANVAS: Finish = { surface: 'plain', rough: 0.95, twoSided: true };
const STONES: Palette = ['#d9d4c9', '#cec9bd', '#c3beb2'];
const GREENS: Palette = ['#3f7a3c', '#4d8a45', '#366b36', '#5b9650'];
const NEEDLES: Palette = ['#3f6b4a', '#4a7a55', '#335c40', '#5a8a62'];
/** The square: its middle, its radius. */
const SQUARE: [number, number] = [0, -1];
const SQUARE_RADIUS = 6.2;
/** Where the quay runs, along the south shore, and its depth. */
const QUAY_Z = HALF - 2.4;
const QUAY_DEPTH = 2.2;
const QUAY_HALF = 9.5;
/** The piers' feet on the quay's water side, and how far each runs out. */
const PIERS: readonly [x: number, length: number][] = [[-6.5, 5.2], [0, 7.5], [6.5, 5.2]];
/** The awnings' stripes, the market's colours. */
const AWNINGS: readonly [string, string][] = [
  ['#d9534f', '#f4ede1'],
  ['#3f7cc4', '#f4ede1'],
  ['#e0a535', '#f4ede1'],
  ['#4f9a5a', '#f4ede1'],
];

/** A round island whose shore wanders a little, each way its own. */
class Harbour extends Site {
  constructor() {
    super(SEED, [], HARBOR_ISLAND);
  }
}

/** The paved square: flagstones inside a ring of kerbs, and a round planter of stones in its middle for the great tree. */
function square(b: Builder): void {
  const [x, z] = SQUARE;
  b.cyl(SQUARE_RADIUS, 0.04, [x, 0.012, z], '#ffffff', { ...PAVING, sides: 64 });
  const kerbs = 72;
  for (let kerb = 0; kerb < kerbs; kerb++) {
    const angle = (kerb / kerbs) * TAU;
    b.box([0.55, 0.1, 0.18], [x + Math.cos(angle) * SQUARE_RADIUS, 0.045, z + Math.sin(angle) * SQUARE_RADIUS], b.pick(STONES), { ...STONE, vary: 0.05 }, -angle - QUARTER);
  }
  // The planter.
  const stones = 22;
  for (let stone = 0; stone < stones; stone++) {
    const angle = (stone / stones) * TAU;
    b.box([0.42, 0.32, 0.26], [x + Math.cos(angle) * 1.25, 0.16, z + Math.sin(angle) * 1.25], b.pick(STONES), { ...STONE, vary: 0.08 }, -angle - QUARTER);
  }
  b.cyl(1.15, 0.24, [x, 0.12, z], '#6b5440', { surface: 'soil', rough: 1, sides: 32, shadowless: true });
  tree(b, [x, 0.24, z], { height: 6.2, spread: 6.4, bark: '#5a4436', leaves: ['#5f9a4a', '#6fab55', '#4f8a40', '#84b95f'], lobes: 7 });
  // Benches round the planter, facing it, and a few out at the square's edge facing in.
  for (let index = 0; index < 6; index++) {
    const angle = (index / 6) * TAU + 0.26;
    bench(b, [x + Math.cos(angle) * 2.55, 0.03, z + Math.sin(angle) * 2.55], -angle + QUARTER, '#8a6648', 1.3);
  }
  for (const angle of [0.9, 2.3, 4.0, 5.4]) lantern(b, [x + Math.cos(angle) * (SQUARE_RADIUS - 0.55), 0.03, z + Math.sin(angle) * (SQUARE_RADIUS - 0.55)], { kind: 'post', light: '#ffe2b0' });
}

/** The café on the square's east side: tables with their chairs under parasols, and pots of flowers between them. */
function cafe(b: Builder): void {
  const [x, z] = SQUARE;
  const tables: readonly [number, number][] = [[3.6, -2.6], [4.6, -0.4], [3.8, 1.9], [2.0, 3.6]];
  tables.forEach(([dx, dz], index) => {
    tableSet(b, [x + dx, 0.03, z + dz], 3, { wood: '#8f6a4a', turn: index * 0.7 });
    parasol(b, [x + dx, 0.03, z + dz], index % 2 ? '#f1e3cc' : '#e9c9a7');
  });
  pot(b, [x + 5.2, 0.03, z + 1.0], 1.1, GREENS, ['#ff8fa3', '#ffffff', '#ffd9d9']);
  pot(b, [x + 4.9, 0.03, z - 1.8], 1.1, GREENS, ['#ffd95a', '#fff0a0', '#ffffff']);
}

/** A market stall: four posts, a counter, and an awning striped in two colours sloping to the front. */
function stall(b: Builder, at: V3, turn: number, [stripe, ground]: readonly [string, string]): void {
  b.group(
    at,
    () => {
      for (const [px, pz] of [[-0.9, -0.55], [0.9, -0.55], [-0.9, 0.55], [0.9, 0.55]] as const) b.cyl(0.05, 1.9, [px, 0.95, pz], '#7a5a40', { ...WOOD, sides: 8 });
      b.box([1.9, 0.85, 0.6], [0, 0.43, 0.25], '#9a7656', WOOD);
      b.box([1.95, 0.05, 0.66], [0, 0.88, 0.25], '#b38b66', WOOD);
      // Goods on the counter: little crates and jars in the stall's colours.
      for (let item = 0; item < 4; item++) b.box([0.28, 0.18, 0.24], [-0.6 + item * 0.4, 1.0, 0.25], item % 2 ? stripe : '#d8b57a', WOOD);
      const stripes = 8;
      for (let index = 0; index < stripes; index++) {
        b.box([1.98 / stripes, 0.03, 1.45], [-0.99 + (index + 0.5) * (1.98 / stripes), 2.02, 0.05], index % 2 ? ground : stripe, CANVAS, [-0.2, 0, 0]);
      }
    },
    turn,
  );
}

/** The market on the square's west side, its stalls facing the square. */
function market(b: Builder): void {
  const [x, z] = SQUARE;
  const spots: readonly [number, number][] = [[-7.6, -4.2], [-8.4, -1.2], [-8.2, 1.9], [-7.0, 4.6]];
  spots.forEach(([dx, dz], index) => {
    const angle = Math.atan2(-dz, -dx);
    stall(b, [x + dx, 0.02, z + dz], QUARTER - angle, AWNINGS[index % AWNINGS.length]!);
  });
  for (const [dx, dz] of [[-6.6, -2.7], [-6.9, 3.2]] as const) barrel(b, [x + dx, 0.02, z + dz], 0.9);
}

/** The notice board at the square's north edge: a roofed board on two posts, faced toward the square. */
function noticeBoard(b: Builder): void {
  const [x, z] = SQUARE;
  b.group(
    [x + 0.4, 0.02, z - SQUARE_RADIUS - 0.9],
    () => {
      for (const side of [-1, 1]) b.cyl(0.07, 2.1, [side * 1.05, 1.05, 0], '#6b4c36', { ...WOOD, sides: 8 });
      b.box([2.0, 1.15, 0.08], [0, 1.35, 0.02], '#8a6648', WOOD);
      b.box([1.8, 0.95, 0.02], [0, 1.35, 0.07], '#e9dcc0', { surface: 'plain', rough: 0.95 });
      // Notes pinned to it.
      const notes = ['#fff4b0', '#cfe8ff', '#ffd6e0', '#d8f5c8', '#ffe2b8'];
      notes.forEach((paper, index) => b.box([0.32, 0.36, 0.01], [-0.62 + index * 0.31, 1.42 + (index % 2) * 0.12 - 0.1, 0.085], paper, { surface: 'plain', rough: 1 }, [0, 0, (index - 2) * 0.06]));
      b.box([2.3, 0.06, 0.5], [0, 2.12, 0.05], '#6b4c36', WOOD, [0.15, 0, 0]);
    },
    0,
  );
}

/** The quay along the south shore, its three piers out over the water, boats made fast to them, and what a harbour keeps on its boards. */
function harbour(b: Builder): void {
  // The quay's deck: planks across, on the shore's edge.
  const planks = Math.round((QUAY_HALF * 2) / 0.16);
  for (let plank = 0; plank < planks; plank++) {
    const x = -QUAY_HALF + (plank + 0.5) * ((QUAY_HALF * 2) / planks);
    b.box([(QUAY_HALF * 2) / planks - 0.01, 0.05, QUAY_DEPTH], [x, 0.05, QUAY_Z], '#9a7a5a', WOOD);
  }
  b.box([QUAY_HALF * 2 + 0.1, 0.12, 0.12], [0, 0.04, QUAY_Z + QUAY_DEPTH / 2], '#6f5640', WOOD);
  for (let post = 0; post <= 12; post++) b.cyl(0.07, 1.1, [-QUAY_HALF + (post / 12) * QUAY_HALF * 2, -0.4, QUAY_Z + QUAY_DEPTH / 2 - 0.05], '#5f4a38', { surface: 'bark', sides: 8 });
  for (const [x, length] of PIERS) {
    jetty(b, [x, 0.05, QUAY_Z + QUAY_DEPTH / 2], length, 1.1, { wood: '#8f7a62', lamp: true }, 0);
    boat(b, [x + 1.05, WATER_LEVEL, QUAY_Z + QUAY_DEPTH / 2 + length * 0.62], 0.12, x < 0 ? '#6b4a35' : '#3f6a8f');
    b.life({ kind: 'ripples', at: [x + 1.1, WATER_LEVEL, QUAY_Z + QUAY_DEPTH / 2 + length * 0.7], reach: 0.9 });
  }
  boat(b, [-2.6, WATER_LEVEL, QUAY_Z + QUAY_DEPTH / 2 + 2.6], -0.4, '#8a3f34');
  // Crates and barrels on the boards, lamps along the edge.
  const crates: readonly [number, number, number][] = [[-8.6, -0.4, 0.2], [-8.0, -0.6, -0.3], [-8.3, 0.1, 0.9], [8.2, -0.5, 0.4], [7.6, -0.3, -0.2]];
  for (const [x, dz, turn] of crates) b.box([0.5, 0.42, 0.5], [x, 0.29, QUAY_Z + dz], '#a8835a', WOOD, turn);
  for (const x of [-3.4, 3.2, 4.0]) barrel(b, [x, 0.07, QUAY_Z - 0.45], 0.9);
  for (const x of [-9, -3.2, 3.2, 9]) lantern(b, [x, 0.07, QUAY_Z + 0.75], { kind: 'post', light: '#ffd9a0' });
  // A railing along the quay's back where the lawn begins, open where the way comes down from the square.
  fence(b, [-QUAY_HALF, QUAY_Z - QUAY_DEPTH / 2 - 0.1], [-1.4, QUAY_Z - QUAY_DEPTH / 2 - 0.1], { kind: 'rail', height: 0.7, color: '#7a5d44' });
  fence(b, [1.4, QUAY_Z - QUAY_DEPTH / 2 - 0.1], [QUAY_HALF, QUAY_Z - QUAY_DEPTH / 2 - 0.1], { kind: 'rail', height: 0.7, color: '#7a5d44' });
}

/** The way down from the square to the quay: flagstones in a band. */
function way(b: Builder): void {
  const [x, z] = SQUARE;
  const from = z + SQUARE_RADIUS;
  const to = QUAY_Z - QUAY_DEPTH / 2;
  const steps = Math.max(1, Math.round((to - from) / 0.62));
  for (let step = 0; step < steps; step++) {
    const along = from + (step + 0.5) * ((to - from) / steps);
    for (const side of [-0.62, 0, 0.62]) b.box([0.58, 0.05, 0.56], [x + side, 0.02, along], b.pick(STONES), { ...PAVING, vary: 0.08 });
  }
}

/** The hill's edge: pines along the north shore, trees and shrubs round the rest, rocks where the bank turns. */
function planting(b: Builder, site: Site): void {
  for (let index = 0; index < 14; index++) {
    const angle = Math.PI + 0.25 + (index / 13) * (Math.PI - 0.5);
    const away = HALF - 2.6 - hash(index, 3, SEED) * 1.6;
    pine(b, [Math.cos(angle) * away, 0, Math.sin(angle) * away], { height: 3.6 + hash(index, 5, SEED) * 1.8, spread: 2.2, needles: NEEDLES });
  }
  for (const [x, z, height] of [[13.5, 4, 3.8], [-13.5, 4.5, 3.6], [12.5, -6, 4.2], [-12.8, -6.5, 4.0]] as const) {
    tree(b, [x, 0, z], { height, spread: 3.2, bark: '#5a4436', leaves: ['#6f9a48', '#85ab55', '#5d8840'], lobes: 5 });
  }
  for (const [x, z, radius] of [[10.5, 7.5, 0.55], [-10.5, 8, 0.5], [11.5, 1.2, 0.48], [-11.5, 1.6, 0.5]] as const) {
    bush(b, [x, 0, z], radius, GREENS, { colors: ['#ffffff', '#ffd95a', '#ff8fa3'], count: Math.round(radius * 30) });
  }
  flowerBed(b, [9.5, -2.5], [1.6, 1.1], Math.round(160 * b.density), ['#ffffff', '#ffd95a', '#ff8fa3', '#c9a0ff'], { height: [0.14, 0.28], keep: (x, z) => site.shore(x, z) > 1.2 });
  for (const [x, z, size] of [[-14.5, 9.5, 0.7], [14.4, 9.2, 0.6], [15.2, -2, 0.55], [-15.4, -1.5, 0.6]] as const) rock(b, [x, 0, z], size, b.pick(LOOK.rocks), 0.7);
  lilies(b, [-11, HALF + 1.2], WATER_LEVEL, [1.0, 0.6], 7);
}

/** Nothing the shore's dressing lays (stones, reeds) on the quay's stretch of shore. */
const atQuay = (x: number, z: number) => Math.abs(x) < QUAY_HALF + 0.5 && z > QUAY_Z - QUAY_DEPTH;

/** The shared island, everything of it that stands still. */
export function buildHarbor(lush = true): Build {
  const b = new Builder(SEED);
  if (!lush) b.density = 0.62;
  const site = new Harbour();
  // The square, the café, the stalls and the quay are kept bare of what the ground would scatter.
  ground(b, site, LOOK, 0.34);
  square(b);
  cafe(b);
  market(b);
  noticeBoard(b);
  way(b);
  harbour(b);
  planting(b, site);
  b.life({ kind: 'fireflies', at: [SQUARE[0], 1.2, SQUARE[1]], reach: 3, count: 8 });
  b.life({ kind: 'butterfly', at: [9.5, 0.6, -2.5], color: '#fff3b0', phase: 0.4 });
  dressShore(b, site, LOOK, atQuay);
  return b.finish();
}
