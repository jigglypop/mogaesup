import type { Element } from '../elements';
import type { House } from '../profile';
import { barrel, bench, boat, chimney, clothesline, doorAt, fence, gableRoof, giwaRoof, hanging, jar, jetty, jige, lantern, parasol, pot, railing, sawhorse, slope, stack, steps, stoneWall, tableSet, well, windowAt, woodpile, type Cover } from './arch';
import { Builder, type Build, type Finish, type V3 } from './build';
import { WATER_LEVEL } from './mood';
import { bamboo, birch, bush, conifer, flowerBed, lilies, pine, reeds, rock, steppingStones, tree, vine, willow, type Palette } from './plants';
import { dressPond, dressShore, ground, GROUND_STEP, ISLANDS, shoreAt, Site, type GroundLook, type IslandKind, type IslandShape, type Pond } from './terrain';
import { emblem, keepsake } from './yard';

export type { IslandKind } from './terrain';

// The five homes, one for each element a chart can lean to. Each stands on its own island in the lake, the lawn at
// y = 0, and is finished on every side: a camera goes all the way round it. A home with its whole garden (`home`)
// holds it out to its farther shore; a neighbour's keeps the house, its ground and shore and two or three trees, and
// nothing small or moving. The trees stand between the landings bridges come to (the middle of each side and the
// corners) and out of the way of the house's walls. A home leaves the same places free: the guardian's (front right),
// and with its whole garden the day master's symbol (right) and the second element's keepsake (the near corner). The
// page's own island is an estate, laid out about the house alone (see HomeEstate). A metre here is about two of ours:
// a door is a metre high.

/** Where the house stands on its island, and the places kept for what the chart adds. */
export const HOUSE: V3 = [-1.3, 0, -1.5];
export const GUARDIAN_AT: V3 = [1.7, 0, 2.7];
export const EMBLEM_AT: V3 = [4.0, 0, 0.5];
export const KEEPSAKE_AT: V3 = [4.3, 0, 4.1];
/** The door's place along the house's front. */
const DOOR_X = 1;
const QUARTER = Math.PI / 2;
const TAU = Math.PI * 2;
/** Turns for what faces the back (north) and the west side of a house. */
const BACK = Math.PI;
const WEST = -QUARTER;
const WOOD: Finish = { surface: 'wood', rough: 0.8 };
const MASONRY: Finish = { surface: 'masonry', rough: 0.9 };
const STONE: Finish = { surface: 'stone', rough: 0.88 };
const IRON: Finish = { metal: 0.5, rough: 0.5 };
const GREENS: Palette = ['#3f7a3c', '#4d8a45', '#366b36', '#5b9650'];
/** How thinly a neighbour's shore is set with stones, and its reeds. */
const LIGHT_SHORE = { share: 0.45, reeds: 0 };

const SEED: Record<Element, number> = { wood: 11, fire: 23, earth: 37, metal: 41, water: 53 };

/** How far a bridge's foot reaches up a bank: what stands within a step of that is in its way. */
const LANDING_FOOT = 0.75;

/**
 * The island a house's whole garden is planted on: the page's own island before it became an estate (see HomeEstate),
 * a quarter more ground to each side than a neighbour's, cut as finely. A neighbour's house keeps its own island.
 */
const GARDEN: IslandShape = { half: 6.9, corner: 3.2, reach: 8.8 };
const GARDENS: Record<IslandKind, IslandShape> = { home: GARDEN, neighbour: ISLANDS.neighbour };
const GARDEN_STEPS: Record<IslandKind, number> = { home: 0.14, neighbour: GROUND_STEP.neighbour };

/**
 * Whether (x, z) is in the way of a bridge at one of an island's landings, in the middle of each side and at the
 * corners: a bridge comes to a neighbour's island from the middle one, at whichever landing faces it, and to the
 * middle one from any side. The way runs from a little inland of the bridge's foot out over the water, `across` to
 * either side of the bridge's line: wider for a stone or a clump of reeds, which reach past where they are put.
 */
const landing =
  (shape: IslandShape, across: number) =>
  (x: number, z: number): boolean => {
    for (let index = 0; index < 8; index++) {
      const bearing = (index / 8) * TAU;
      const [cos, sin] = [Math.cos(bearing), Math.sin(bearing)];
      const out = x * cos + z * sin - (shoreAt(shape, bearing) - LANDING_FOOT);
      if (out > -0.95 && out < 3 && Math.abs(z * cos - x * sin) < across) return true;
    }
    return false;
  };
/** How far to either side of a bridge's line the shore's stones and its reeds are kept back. */
const BRIDGE_WAY = { stones: 1.1, reeds: 1.45 } as const;

/** What a plan is drawn for: the island's kind, and a spot for each kind of island (a neighbour's, the page's own). */
type Yard = { kind: IslandKind; at: (neighbour: [number, number], home: [number, number]) => V3 };
const yardOf = (kind: IslandKind): Yard => ({ kind, at: (neighbour, home) => (kind === 'home' ? [home[0], 0, home[1]] : [neighbour[0], 0, neighbour[1]]) });

type Plan = {
  ground: GroundLook;
  ponds?: Record<IslandKind, Pond[]>;
  /** Yards kept bare of grass: ovals `rx` by `rz` about (x, z). */
  bare?: Record<IslandKind, [number, number, number, number][]>;
  /** The house about {@link HOUSE}, every side of it; `full` adds what is small about it: pots, flowers, lamps, smoke. */
  house: (b: Builder, full: boolean) => void;
  /** The two or three trees every island of this house keeps, a neighbour's too. */
  trees: (b: Builder, yard: Yard) => void;
  /** The rest of the garden, on the page's own island. */
  garden: (b: Builder, site: Site) => void;
};

/** The stone path from the door's steps to the south landing, where a bridge may come, lamps beside it. */
function path(b: Builder, from: [number, number], stones: Palette, light?: string): void {
  const end = shoreAt(GARDEN, QUARTER) - LANDING_FOOT - 0.45;
  steppingStones(b, [from, [from[0] - 0.05, (from[1] + end - 0.8) / 2], [-0.12, end - 0.8], [0, end]], 0.5, stones);
  for (const [x, z] of [[from[0] - 0.55, from[1] + 0.35], [0.3, (from[1] + end - 0.6) / 2 + 0.2], [-0.7, end - 0.5]] as const) lantern(b, [x, 0, z], { kind: 'path', ...(light ? { light } : {}) });
}

function mushroom(b: Builder, x: number, z: number, scale: number, cap: string): void {
  b.cyl(0.03 * scale, 0.1 * scale, [x, 0.05 * scale, z], '#f3ead8', { sides: 7, rough: 0.9 });
  b.dome([0.09 * scale, 0.07 * scale, 0.09 * scale], [x, 0.09 * scale, z], cap, { detail: 10, rough: 0.6 });
}

function fern(b: Builder, x: number, z: number, size = 0.46): void {
  for (let blade = 0; blade < 8; blade++) {
    const turn = (blade / 8) * TAU + b.between(-0.2, 0.2);
    b.sprig('frond', [x, 0.02, z], size * b.between(0.8, 1.15), b.pick(['#4f8a45', '#5f9a50', '#447a3e']), [Math.cos(turn) * 0.75, 0.6, Math.sin(turn) * 0.75], b.between(0, TAU), [0, 1, 0], b.between(0.8, 1.05));
  }
}

/** A 한옥's door or window: paper lit from behind its lattice, in a timber frame, its middle at `at`. */
function paper(b: Builder, at: V3, size: [number, number], timber: string, turn = 0, leaves = 1): void {
  b.group(
    at,
    () => {
      const [wide, tall] = size;
      for (let leaf = 0; leaf < leaves; leaf++) b.pane([wide / leaves - 0.03, tall], [-wide / 2 + (wide / leaves) * (leaf + 0.5), 0, 0.012], 'paper', 2.1);
      for (const y of [-1, 1]) b.box([wide + 0.1, 0.05, 0.06], [0, y * (tall / 2 + 0.025), 0.02], timber, WOOD);
      for (let stile = 0; stile <= leaves; stile++) b.box([0.045, tall, 0.06], [-wide / 2 + (wide / leaves) * stile, 0, 0.02], timber, WOOD);
    },
    turn,
  );
}

/** A gutter under the back eave (`y` high, `z` out from the house's middle) and its pipe down the corner at `x` into a butt. */
function downpipe(b: Builder, x: number, y: number, z: number, wall: number, full: boolean): void {
  b.cyl(0.045, 4.9, [0, y, z], '#3a3532', { ...IRON, sides: 8 }, [0, 0, QUARTER]);
  const face = wall - 0.04;
  b.limb([[x, y - 0.02, z], [x, y - 0.16, (z + face) / 2], [x, y - 0.3, face], [x, 0.72, face], [x, 0.62, face - 0.17]], [0.032], '#3a3532', { ...IRON, sides: 8 });
  if (full) barrel(b, [x, 0, face - 0.34]);
}

const SHAKES: Cover = { kind: 'shingle', shingles: ['#7a6652', '#8a7560', '#6b5a48', '#94806a', '#6f7355'] };
const FIRS: Palette = ['#2f5f3f', '#3a6f48', '#285238', '#467d52'];
const BIRCH: Palette = ['#9fc25a', '#b3cf68', '#8ab04d'];

/** 목: a cabin of logs under wooden shakes, deep among firs. */
const wood: Plan = {
  ground: { lawn: ['#4c7c38', '#5f8f3f', '#77a04a'], dirt: '#6b5138', bank: '#8f8674', rocks: ['#7f7b70', '#8f8b7e', '#6c6a60'] },
  house: (b, full) => {
    const logs: Palette = ['#8a5f3d', '#946843', '#7c5435', '#9f744c'];
    const dark = '#4a3324';
    const cream = '#e9dcc0';
    const green = '#3f5a40';
    const bark: Finish & { sides: number } = { sides: 10, surface: 'bark', rough: 0.95, vary: 0.08 };
    const sawn: Finish & { sides: number } = { sides: 10, surface: 'wood', vary: 0.08 };
    b.box([4.7, 0.24, 3.9], [0, 0.12, 0], '#ffffff', MASONRY);
    b.box([4.25, 2.0, 3.45], [0, 1.24, 0], '#2f2219', { rough: 1 });
    // The walls: logs laid one on another all round, crossing at the corners, their sawn ends pale.
    const round = 0.115;
    for (let course = 0; course < 9; course++) {
      const y = 0.24 + round + course * round * 1.9;
      for (const side of [1, -1]) {
        b.cyl(round, 4.9, [0, y, side * 1.78], b.pick(logs), bark, [0, 0, QUARTER]);
        b.cyl(round, 4.1, [side * 2.18, y + round * 0.95, 0], b.pick(logs), bark, [QUARTER, 0, 0]);
        for (const end of [1, -1]) {
          b.cyl(round * 0.9, 0.012, [end * 2.455, y, side * 1.78], '#d2b58c', sawn, [0, 0, QUARTER]);
          b.cyl(round * 0.9, 0.012, [side * 2.18, y + round * 0.95, end * 2.055], '#d2b58c', sawn, [QUARTER, 0, 0]);
        }
      }
    }
    gableRoof(b, [0, 2.26, 0], { width: 4.4, depth: 3.7, rise: 1.75, over: 0.42, verge: 0.3, both: true, cover: SHAKES, wall: '#8a6444', wallFinish: WOOD, trim: dark });
    for (const side of [1, -1]) windowAt(b, [side * 2.205, 3.0, 0.1], { size: [0.5, 0.5], frame: cream, bars: [2, 2] }, side * QUARTER);
    chimney(b, [2.52, 0, -1.05], [0.6, 0.76], 4.3, { surface: 'masonry' });

    // The porch along the front: a deck, posts of whole logs, a roof of its own.
    b.box([4.5, 0.07, 1.05], [0, 0.275, 2.42], '#9a7350', { ...WOOD, vary: 0.05 });
    b.group([0, 1.7, 1.86], () => slope(b, 4.7, 1.15, 0.44, SHAKES));
    b.box([4.6, 0.1, 0.1], [0, 1.68, 2.9], dark, WOOD);
    for (const x of [-2.15, -0.9, 0.38, 1.62]) b.cyl(0.07, 1.4, [x, 1.0, 2.9], b.pick(logs), { sides: 10, surface: 'bark' });
    for (const [from, to] of [[-2.15, -0.9], [-0.9, 0.38]] as const) {
      for (const y of [0.58, 0.82]) b.box([to - from, 0.045, 0.045], [(from + to) / 2, y, 2.9], dark, WOOD);
      for (let post = 1; post < 6; post++) b.box([0.03, 0.5, 0.03], [from + ((to - from) * post) / 6, 0.57, 2.9], dark, WOOD);
    }
    steps(b, [DOOR_X, 0, 3.36], 1.1, 2, { rise: 0.12, tread: 0.2, color: '#9a7350', surface: 'wood' });
    doorAt(b, [DOOR_X, 0.31, 1.9], { size: [0.56, 1.1], color: green, frame: cream });
    const flowers: Palette = ['#ff8fa3', '#ffffff', '#ffd95a', '#c9a0ff'];
    windowAt(b, [-1.1, 1.22, 1.9], { size: [0.95, 0.72], frame: cream, bars: [3, 2], shutters: green, ...(full ? { flowers } : {}) });
    windowAt(b, [2.3, 1.22, 0.75], { size: [0.8, 0.7], frame: cream, bars: [2, 2], shutters: green }, QUARTER);
    // The west: a window over the clearing, and a small one toward the back corner.
    windowAt(b, [-2.3, 1.22, 0.55], { size: [0.8, 0.7], frame: cream, bars: [2, 2], shutters: green, ...(full ? { flowers } : {}) }, WEST);
    windowAt(b, [-2.3, 1.3, -0.95], { size: [0.46, 0.5], frame: cream, bars: [2, 2] }, WEST);
    // The back: a door onto a stoop of planks, and a window beside it.
    doorAt(b, [1.1, 0.24, -1.9], { size: [0.56, 1.06], color: green, frame: cream }, BACK);
    steps(b, [1.1, 0, -2.35], 0.9, 2, { rise: 0.12, tread: 0.2, color: '#9a7350', surface: 'wood' }, BACK);
    windowAt(b, [-0.15, 1.28, -1.9], { size: [0.62, 0.56], frame: cream, bars: [2, 2], shutters: green }, BACK);
    if (!full) return;

    b.life({ kind: 'smoke', at: [2.52, 4.6, -1.05] });
    lantern(b, [DOOR_X + 0.52, 1.22, 1.9], { kind: 'wall' });
    lantern(b, [1.62, 1.2, -1.9], { kind: 'wall' }, BACK);
    b.box([0.9, 0.05, 0.3], [-1.35, 0.52, 2.2], '#7a5639', WOOD);
    for (const x of [-1.72, -0.98]) b.box([0.05, 0.2, 0.26], [x, 0.4, 2.2], '#7a5639', WOOD);
    woodpile(b, [-0.2, 0.31, 2.1], QUARTER, 2);
    woodpile(b, [2.7, 0, 1.2], QUARTER);
    // The woodshed against the back: a lean-to of shakes on two posts, the winter's wood stacked dry under it.
    b.group(
      [-1.6, 0, -1.9],
      () => {
        b.group([0, 1.6, 0], () => slope(b, 1.55, 0.78, 0.3, SHAKES));
        for (const x of [-0.7, 0.7]) b.cyl(0.045, 1.62, [x, 0.81, 0.72], b.pick(logs), { sides: 8, surface: 'bark' });
        stack(b, [0, 0, 0.34], 1.3, 0.84);
      },
      BACK,
    );
    barrel(b, [1.9, 0, -2.32]);
  },
  trees: (b, yard) => {
    conifer(b, yard.at([4.3, -2.3], [5.6, -2.7]), { height: 5.2, radius: 1.3, needles: FIRS });
    conifer(b, yard.at([-4.3, 2.3], [-5.6, 2.6]), { height: 4.4, radius: 1.1, needles: FIRS });
    birch(b, yard.at([-2.2, 4.4], [-2.8, 5.6]), { height: 3.3, leaves: BIRCH });
  },
  garden: (b, site) => {
    site.keep(HOUSE[0], HOUSE[2] + 0.2, 2.8, 3.0).keep(-0.3, 2.3, 0.75, 0.6);
    // Behind the house, out of the way of its back: a fir beyond the chimney, a young birch by the corner.
    conifer(b, [2.5, 0, -5.6], { height: 4.8, radius: 1.15, needles: FIRS });
    birch(b, [-4.7, 0, -4.4], { height: 2.8, leaves: BIRCH });

    // A clearing: the chopping block, mushrooms, ferns and mossy stones.
    b.group([-3.4, 0, 3.6], () => {
      b.cyl(0.25, 0.3, [0, 0.15, 0], '#8b6444', { sides: 14, surface: 'bark' });
      b.cyl(0.23, 0.012, [0, 0.305, 0], '#d9bd92', { sides: 14, surface: 'wood' });
      b.box([0.035, 0.6, 0.035], [0.1, 0.52, -0.02], '#7a5a42', WOOD, [0, 0, -0.5]);
      b.box([0.16, 0.1, 0.03], [-0.07, 0.4, -0.02], '#9aa3b3', { metal: 0.8, rough: 0.35 }, [0, 0, -0.5]);
    });
    woodpile(b, [-4.4, 0, 4.4], 0.5);
    for (const [x, z, scale, cap] of [[-2.6, 4.3, 1.2, '#c8402f'], [-2.35, 4.05, 0.8, '#c8402f'], [-4.5, 2.9, 1, '#b5803a'], [-2.9, 2.6, 0.9, '#c8402f'], [-1.9, 5.0, 1.1, '#b5803a'], [-2.5, -5.2, 1, '#c8402f'], [-4.9, -2.8, 0.9, '#b5803a'], [1.9, -4.7, 1.1, '#c8402f']] as const) mushroom(b, x, z, scale, cap);
    for (const [x, z] of [[-4.2, 1.35], [-1.9, 2.9], [-4.7, 4.8], [1.2, 5.1], [5.0, 2.5], [-5.4, 1.0], [3.2, -4.6], [-1.6, -5.0], [-3.4, -5.0], [-5.2, -3.4], [-5.0, -1.6]] as const) fern(b, x, z);
    for (const [x, z, size] of [[-3.95, 4.5, 0.55], [-1.8, 3.95, 0.3], [5.4, 1.4, 0.5], [-3.9, -5.4, 0.45], [-5.5, -2.2, 0.35]] as const) {
      rock(b, [x, 0, z], size, b.pick(['#6f7a62', '#7d8570', '#5f6a55']), 0.7);
      for (let moss = 0; moss < 5; moss++) b.sprig('leaf', [x + b.between(-0.15, 0.15), size * 0.36, z + b.between(-0.15, 0.15)], 0.15, '#5a8a45', [0, 1, 0], moss, [0, 1, 0], 0.9);
    }
    // Behind: a log on the sawhorse, waiting for the saw.
    sawhorse(b, [0.9, 0, -5.0], 0.35);
    flowerBed(b, [-1.6, 3.9], [0.5, 0.9], 22, ['#8f9cf0', '#ffffff', '#c9a0ff', '#ffd95a'], { height: [0.12, 0.26], size: 0.08 });
    flowerBed(b, [0.85, 4.4], [0.45, 0.8], 18, ['#ffffff', '#ffd95a', '#ff8fa3'], { height: [0.12, 0.26], size: 0.08, keep: (x, z) => Math.hypot(x - GUARDIAN_AT[0], z - GUARDIAN_AT[2]) > 0.8 });
    bush(b, [1.25, 0, 1.75], 0.42, GREENS, { colors: ['#ffffff', '#ffe9f0'], count: 12 });
    path(b, [-0.3, 2.3], ['#8f8674', '#9c9382', '#7f7768']);
    b.life({ kind: 'fireflies', at: [-3.9, 0.6, 2.6], reach: 1.5, count: 8 });
    b.life({ kind: 'fireflies', at: [3.8, 0.7, -2.6], reach: 1.2, count: 5 });
    b.life({ kind: 'fireflies', at: [-2.6, 0.6, -5.0], reach: 1.2, count: 5 });
    b.life({ kind: 'butterfly', at: [-1.6, 0.6, 3.9], color: '#fff3b0', phase: 0 });
    b.life({ kind: 'butterfly', at: [0.9, 0.7, 4.4], color: '#ffb7c5', phase: 2.4 });
  },
};

const TILES: Cover = { kind: 'barrel', tiles: ['#b5553a', '#c2603f', '#a84c35', '#cc6e4a'], pan: '#7d3a2b' };
const ROSES: Palette = ['#c8283a', '#d93a4a', '#b01f33', '#e8566a'];

/** 화: red brick under clay tiles, roses up its walls, a fire burning in the garden. */
const fire: Plan = {
  ground: { lawn: ['#739a40', '#8db04e', '#a6bf60'], dirt: '#8b6b4b', bank: '#b09679', rocks: ['#a39788', '#b7ab9b', '#8e8377'] },
  house: (b, full) => {
    const brick: Finish = { surface: 'brick', rough: 0.9 };
    const trim = '#5a3a2a';
    const cream = '#efe3cf';
    const shutter = '#3d5a47';
    // The house: a plinth of stone, two floors of brick, a band of stone between them, dressed stone up every corner.
    b.box([4.6, 0.2, 3.6], [0, 0.1, 0], '#ffffff', MASONRY);
    b.box([4.4, 2.72, 3.4], [0, 1.56, 0], '#ffffff', brick);
    b.box([4.47, 0.07, 3.47], [0, 1.62, 0], cream, STONE);
    for (const sx of [1, -1]) {
      for (const sz of [1, -1]) {
        for (let block = 0; block < 9; block++) {
          const long = block % 2 === 0;
          b.box([long ? 0.34 : 0.22, 0.22, long ? 0.22 : 0.34], [sx * (2.2 - (long ? 0.15 : 0.09)), 0.36 + block * 0.3, sz * (1.7 - (long ? 0.09 : 0.15))], cream, { ...STONE, vary: 0.06 });
        }
      }
    }
    gableRoof(b, [0, 2.92, 0], { width: 4.4, depth: 3.4, rise: 1.3, over: 0.38, verge: 0.26, both: true, cover: TILES, wall: '#ffffff', wallFinish: brick, trim });
    // A round light high in each gable.
    for (const side of [1, -1]) {
      b.cyl(0.2, 0.02, [side * 2.21, 3.5, 0], cream, { sides: 20, surface: 'stone' }, [0, 0, QUARTER]);
      b.cyl(0.15, 0.03, [side * 2.215, 3.5, 0], '#ffe2a6', { sides: 20, glow: '#ffcf85', power: 2.2 }, [0, 0, QUARTER]);
    }

    // The chimney up the east gable.
    chimney(b, [2.48, 0, -0.85], [0.56, 0.7], 4.55, { surface: 'masonry' });

    // The entrance: a gabled porch, the door in it.
    b.box([1.7, 1.5, 0.95], [DOOR_X, 0.95, 2.17], '#ffffff', brick);
    gableRoof(b, [DOOR_X, 1.7, 2.1], { width: 1.25, depth: 1.7, rise: 0.62, over: 0.2, verge: 0.2, both: true, cover: TILES, wall: cream, wallFinish: { surface: 'plaster' }, trim }, QUARTER);
    b.box([1.5, 0.07, 0.05], [DOOR_X, 1.75, 2.68], trim, WOOD);
    b.box([0.06, 0.46, 0.05], [DOOR_X, 2, 2.68], trim, WOOD);
    doorAt(b, [DOOR_X, 0.2, 2.65], { size: [0.56, 1.08], color: '#8a2f24', frame: cream, transom: true, double: true });
    steps(b, [DOOR_X, 0, 3.26], 1.5, 3, { rise: 0.066, tread: 0.2, color: '#d9cfbd' });

    // Windows: a wide one with shutters below, a balcony and its doors above, an arched light over the porch; the east
    // and the west alike, a shuttered one below and a small one above.
    windowAt(b, [-1.05, 0.98, 1.701], { size: [1.0, 0.74], frame: cream, bars: [3, 2], sill: cream, shutters: shutter, ...(full ? { flowers: ROSES } : {}) });
    windowAt(b, [-1.05, 2.16, 1.701], { size: [0.66, 0.96], frame: cream, bars: [2, 3] });
    windowAt(b, [DOOR_X, 2.36, 1.701], { size: [0.6, 0.36], frame: cream, bars: [2, 1], arch: true, sill: cream });
    for (const side of [1, -1]) {
      windowAt(b, [side * 2.201, 0.98, side * 0.55], { size: [0.82, 0.72], frame: cream, bars: [2, 2], sill: cream, shutters: shutter }, side * QUARTER);
      windowAt(b, [side * 2.201, 2.2, side * 0.75], { size: [0.5, 0.66], frame: cream, bars: [2, 2], sill: cream }, side * QUARTER);
    }
    b.box([2.0, 0.07, 0.56], [-1.05, 1.6, 1.98], cream, STONE);
    for (const x of [-1.85, -0.25]) b.box([0.08, 0.2, 0.4], [x, 1.47, 1.9], cream, STONE);
    railing(b, [-2.03, 1.635, 2.24], [-0.07, 1.635, 2.24], { color: '#2b2829' });
    railing(b, [-2.03, 1.635, 1.72], [-2.03, 1.635, 2.24], { color: '#2b2829' });
    railing(b, [-0.07, 1.635, 2.24], [-0.07, 1.635, 1.72], { color: '#2b2829' });
    // The back: the kitchen's door under a hood of tiles, its window, two windows above, and the rain led down the
    // north-east corner.
    doorAt(b, [1.0, 0.2, -1.701], { size: [0.56, 1.06], color: '#8a2f24', frame: cream, transom: true }, BACK);
    b.group([1.0, 1.5, -1.7], () => slope(b, 1.05, 0.5, 0.2, TILES), BACK);
    for (const x of [-0.42, 0.42]) b.box([0.05, 0.3, 0.05], [1.0 + x, 1.36, -1.86], trim, WOOD, [-0.6, 0, 0]);
    steps(b, [1.0, 0, -2.31], 1.0, 3, { rise: 0.066, tread: 0.17, color: '#d9cfbd' }, BACK);
    windowAt(b, [-0.85, 0.98, -1.701], { size: [0.8, 0.66], frame: cream, bars: [2, 2], sill: cream, shutters: shutter }, BACK);
    for (const x of [-0.85, 1.0]) windowAt(b, [x, 2.2, -1.701], { size: [0.5, 0.66], frame: cream, bars: [2, 2], sill: cream }, BACK);
    downpipe(b, 1.82, 2.57, -2.16, -1.7, full);
    if (!full) return;

    b.life({ kind: 'smoke', at: [2.48, 4.85, -0.85] });
    lantern(b, [DOOR_X - 0.56, 1.02, 2.65], { kind: 'wall' });
    lantern(b, [DOOR_X + 0.56, 1.02, 2.65], { kind: 'wall' });
    lantern(b, [0.5, 1.02, -1.701], { kind: 'wall' }, BACK);
    for (let head = 0; head < 34; head++) {
      const x = -2 + (head / 33) * 1.9;
      b.sprig('leaf', [x, 1.74 + b.between(-0.14, 0.06), 2.3 + b.between(0, 0.06)], b.between(0.16, 0.24), b.pick(GREENS), [0, 0.2, 1], b.between(0, 6), [0, 0.5, 1], b.between(0.8, 1.05));
      b.sprig('bloom', [x + b.between(-0.03, 0.03), 1.78 + b.between(-0.2, 0.1), 2.34 + b.between(0, 0.05)], b.between(0.08, 0.12), b.pick(ROSES), [0, 0.5, 1], b.between(0, 6));
    }
    // Roses climbing the brick, front, east and west.
    b.group([0, 0.2, 1.71], () => vine(b, [-0.02, 0, 0], 0.7, 2.5, GREENS, { colors: ROSES, share: 0.3 }, 1.5));
    b.group([-2.05, 0.2, 1.71], () => vine(b, [0, 0, 0], 0.5, 1.2, GREENS, { colors: ROSES, share: 0.25 }, 1.2));
    b.group([2.21, 0.2, 0], () => vine(b, [-1.2, 0, 0], 0.7, 2.2, GREENS, { colors: ROSES, share: 0.3 }, 1.4), QUARTER);
    b.group([-2.21, 0.2, 0], () => vine(b, [1.15, 0, 0], 0.7, 2.3, GREENS, { colors: ROSES, share: 0.3 }, 1.4), WEST);
    woodpile(b, [2.6, 0, 0.9], QUARTER);
    pot(b, [DOOR_X - 0.98, 0, 3.0], 1, GREENS, ROSES);
    pot(b, [DOOR_X + 0.98, 0, 3.0], 1, GREENS, ['#fff4ea', '#ffd9d9']);
    // Herbs in pots by the kitchen door.
    pot(b, [0.2, 0, -2.08], 0.8, ['#6f9a48', '#85ab55'], ['#c9a0ff', '#ffffff']);
    pot(b, [-0.15, 0, -2.0], 0.65, ['#6f9a48', '#85ab55']);
  },
  trees: (b, yard) => {
    tree(b, yard.at([4.3, -2.3], [5.5, -2.8]), { height: 4.3, spread: 3.3, bark: '#5a4034', leaves: ['#b53423', '#c8452c', '#9c2a1e', '#d95a2f'], lobes: 5 });
    tree(b, yard.at([-2.2, 4.4], [2.6, -5.6]), { height: 3.5, spread: 2.8, bark: '#5a4034', leaves: ['#e08a2e', '#eda23a', '#d06f25', '#f2b84b'], lobes: 4 });
    bush(b, yard.at([-3.3, 0.7], [-3.4, 0.8]), 0.5, GREENS, { colors: ROSES, count: 16 });
  },
  garden: (b, site) => {
    const garden: V3 = [-3.4, 0, 3.3];
    site.keep(HOUSE[0], HOUSE[2] + 0.2, 2.75, 2.5).keep(-0.4, 1.3, 1.2, 1).keep(garden[0], garden[2], 1.75, 1.75).keep(-0.3, -4.0, 0.6, 0.35);
    // The fire garden: a ring of stones on gravel, seats round it, lights strung overhead.
    b.group(garden, () => {
      b.cyl(1.55, 0.04, [0, 0.012, 0], '#cdbfa8', { sides: 40, surface: 'gravel', rough: 0.95, shadowless: true });
      for (let stone = 0; stone < 11; stone++) {
        const angle = (stone / 11) * TAU;
        rock(b, [Math.cos(angle) * 0.42, 0.02, Math.sin(angle) * 0.42], 0.22, b.pick(['#8f867c', '#a0968a', '#7d756c']), 0.75);
      }
      for (const turn of [0, 2.1, 4.2]) {
        b.cyl(0.045, 0.56, [Math.cos(turn) * 0.12, 0.25, Math.sin(turn) * 0.12], '#3d2c22', { sides: 7, surface: 'bark' }, [Math.sin(turn) * 0.55, 0, -Math.cos(turn) * 0.55]);
      }
      b.life({ kind: 'fire', at: [0, 0.12, 0] });
      b.lamp([0, 0.6, 0], '#ff9a4a', 3.4, 6, true);
      for (const [x, z] of [[-1.1, 0.65], [1.05, 1.0], [-0.1, -1.15]] as const) {
        b.cyl(0.17, 0.24, [x, 0.12, z], '#8b6444', { sides: 12, surface: 'bark' });
        b.cyl(0.155, 0.01, [x, 0.245, z], '#d9bd92', { sides: 12, surface: 'wood' });
      }
      const strung = (t: number): V3 => [-1.75 + 3.3 * t, 1.46 - Math.sin(t * Math.PI) * 0.34, 1.25 - 2.75 * t];
      for (const t of [0, 1]) b.cyl(0.03, 1.5, [strung(t)[0], 0.75, strung(t)[2]], '#4a372b', { sides: 6, surface: 'wood' });
      for (let bulb = 0; bulb < 11; bulb++) {
        const at = strung((bulb + 0.5) / 11);
        b.ball(0.035, [at[0], at[1] - 0.03, at[2]], '#ffe7b5', { glow: '#ffc56e', power: 6, detail: 8 });
        if (bulb % 4 === 1) b.lamp(at, '#ffc27a', 0.9, 3);
      }
      b.limb(Array.from({ length: 9 }, (_, index) => strung(index / 8)), [0.006], '#2a2423', { sides: 4, shadowless: true });
    });

    // Maples in their autumn red, roses and beds about the house and along the path.
    tree(b, [-2.9, 0, 5.6], { height: 4.1, spread: 3.2, bark: '#5a4034', leaves: ['#c8452c', '#d95a2f', '#b3381f', '#e27a35'], lobes: 5 });
    bush(b, [-2.4, 0, 0.85], 0.42, GREENS, { colors: ['#fff4ea', '#ffe1e1', '#ffd0d0'], count: 14 });
    bush(b, [1.2, 0, 0.75], 0.44, GREENS, { colors: ROSES, count: 14 });
    bush(b, [5.4, 0, -0.9], 0.6, GREENS, { colors: ['#f3a53a', '#f7c05a', '#e98a2a'], count: 18 });
    bush(b, [-5.4, 0, -1.9], 0.55, GREENS);
    bush(b, [-4.6, 0, -4.3], 0.45, GREENS, { colors: ['#fff4ea', '#ffd9d9'], count: 10 });
    flowerBed(b, [-1.4, 3.6], [0.42, 1.25], 36, ['#e8452f', '#f26a3a', '#ffb23f', '#c8283a']);
    flowerBed(b, [0.75, 3.85], [0.4, 1.1], 30, ['#fff4ea', '#ffd9d9', '#f26a3a', '#ffb23f'], { keep: (x, z) => Math.hypot(x - GUARDIAN_AT[0], z - GUARDIAN_AT[2]) > 0.8 });
    path(b, [-0.3, 1.95], ['#b3a898', '#c2b7a6', '#a39989']);
    fence(b, [-5.8, -1.1], [-5.8, -4.3], { kind: 'rail', color: '#7a5a42' });
    // Behind: the washing out on its line, and a bench under the maple looking out over the lake.
    clothesline(b, [-3.6, -4.8], [-1.3, -5.4], ['#ffffff', '#9fc4e8', '#f2b8c6', '#ffffff', '#f6d77a']);
    bench(b, [2.3, 0, -4.5], BACK, '#7a5a42');
    b.life({ kind: 'fireflies', at: [-4.0, 0.5, 1.0], reach: 1.4, count: 7 });
    b.life({ kind: 'fireflies', at: [-2.2, 0.6, -5.0], reach: 1.2, count: 5 });
    b.life({ kind: 'butterfly', at: [0.7, 0.7, 3.9], color: '#ffe9a8', phase: 0 });
  },
};

/** 토: 황토 기와집, its walls of yellow earth under a 팔작지붕, the yard swept bare, jars on their stand and a wall of stones behind. */
const earth: Plan = {
  ground: { lawn: ['#7a9848', '#8fa955', '#a6b865'], dirt: '#9a7a52', bank: '#b29a78', yard: '#cbb38a', rocks: ['#b0a48f', '#9d927f', '#c0b49e'] },
  bare: {
    neighbour: [[-0.3, 2.35, 3.9, 2.0], [-1.3, -1.3, 3.3, 2.6]],
    home: [[-0.3, 2.6, 4.4, 2.3], [-1.3, -1.7, 3.7, 3.3]],
  },
  house: (b, full) => {
    const timber = '#5e4330';
    const mud = '#d4a76a';
    const plank = '#6e4e36';
    // 기단 of stone, deeper in front where the 섬돌 sits; the house's three 칸 on it: 부엌 (west), 안방, 윗방.
    b.box([5.3, 0.36, 4.2], [0, 0.18, 0.3], '#ffffff', MASONRY);
    b.box([0.9, 0.16, 0.44], [DOOR_X, 0.08, 2.66], '#b9b3a6', STONE);
    b.box([0.78, 0.12, 0.38], [DOOR_X, 0.42, 2.18], '#c4beb0', STONE);
    // 황토 walls between the posts, the kitchen's front darkened by its fire's smoke.
    b.box([4.5, 1.88, 2.8], [0, 1.3, 0], mud, { surface: 'plaster', rough: 0.95 });
    b.box([1.36, 1.5, 0.02], [-1.5, 1.2, 1.405], '#a7835a', { surface: 'plaster', rough: 0.95 });
    // The frame: posts on their stones at the corners, between the 칸 and in the middle of the ends; a sill, a rail
    // across the middle of the walls and the plate on top.
    const posts: [number, number][] = [];
    for (const x of [-2.25, -0.75, 0.75, 2.25]) for (const z of [1.4, -1.4]) posts.push([x, z]);
    posts.push([-2.25, 0], [2.25, 0]);
    for (const [x, z] of posts) {
      b.cyl(0.15, 0.08, [x, 0.4, z], '#b4ab9a', { ...STONE, top: 0.12, sides: 9 });
      b.box([0.17, 1.9, 0.17], [x, 1.39, z], timber, { ...WOOD, vary: 0.06 });
    }
    for (const [y, tall] of [[0.5, 0.12], [1.22, 0.09], [2.26, 0.17]] as const) {
      for (const z of [1.4, -1.4]) b.box([4.64, tall, 0.2], [0, y, z], timber, WOOD);
      for (const x of [2.25, -2.25]) b.box([0.2, tall, 2.94], [x, y, 0], timber, WOOD);
    }

    // The front: the kitchen's plank doors, the 안방's paper door and the 윗방's pair, a 툇마루 before the two rooms.
    for (const side of [-1, 1]) b.box([0.5, 1.42, 0.05], [-1.5 + side * 0.26, 1.13, 1.43], plank, { ...WOOD, vary: 0.08 });
    for (const y of [0.62, 1.62]) b.box([1.08, 0.06, 0.07], [-1.5, y, 1.47], timber, WOOD);
    b.ball(0.03, [-1.44, 1.13, 1.47], '#2e2a26', { ...IRON, detail: 8 });
    paper(b, [0, 1.27, 1.405], [0.74, 1.18], timber, 0, 2);
    paper(b, [1.5, 1.27, 1.405], [1.0, 1.18], timber, 0, 2);
    b.box([3.0, 0.07, 0.64], [0.75, 0.62, 1.74], '#a67c52', { ...WOOD, vary: 0.05 });
    b.box([3.0, 0.1, 0.07], [0.75, 0.54, 2.03], timber, WOOD);
    for (const x of [-0.7, 0.75, 2.2]) b.box([0.09, 0.2, 0.09], [x, 0.46, 1.98], timber, WOOD);
    // The back: the kitchen's door out to the yard behind and a window of each room; the ends, a window each, the
    // kitchen's of bars.
    b.box([0.8, 1.42, 0.05], [-1.5, 1.13, -1.43], plank, { ...WOOD, vary: 0.08 });
    paper(b, [0, 1.42, -1.405], [0.55, 0.46], timber, BACK);
    paper(b, [1.5, 1.42, -1.405], [0.62, 0.5], timber, BACK, 2);
    paper(b, [2.255, 1.42, 0.4], [0.7, 0.56], timber, QUARTER, 2);
    b.box([0.04, 0.5, 0.66], [-2.27, 1.62, 0.55], '#3a2c22', WOOD);
    for (let bar = 0; bar < 7; bar++) b.box([0.05, 0.5, 0.045], [-2.3, 1.62, 0.28 + bar * 0.09], timber, WOOD);

    // 기와지붕: a 팔작지붕, its eaves sweeping up to the corners.
    giwaRoof(b, [0, 2.36, 0], { half: [2.95, 2.15], rise: 1.7, walls: [2.25, 1.4], tiles: '#5d6168', ridge: '#43474e', plaster: '#efe8da', timber: '#5a3f2c' });
    // 굴뚝, low behind the house, out from the back wall: stones and clay, a pot for its cap.
    b.cyl(0.25, 1.3, [1.9, 0.65, -2.32], '#b8976a', { top: 0.19, surface: 'plaster', sides: 12 });
    for (let stone = 0; stone < 7; stone++) {
      const turn = (stone / 7) * TAU;
      b.ball(0.11, [1.9 + Math.cos(turn) * 0.24, 0.08, -2.32 + Math.sin(turn) * 0.24], '#a39988', { ...STONE, scale: [1.2, 0.7, 1], detail: 8 }, turn);
    }
    b.cyl(0.17, 0.2, [1.9, 1.4, -2.32], '#5b3d2c', { top: 0.12, sides: 12, rough: 0.7 });
    if (!full) return;

    b.life({ kind: 'smoke', at: [1.9, 1.55, -2.32], scale: 0.8 });
    // 고무신 on the 섬돌.
    for (const x of [-0.1, 0.1]) b.ball(0.04, [DOOR_X + x, 0.51, 2.2], '#f6f2ea', { scale: [0.8, 0.5, 1.7], rough: 0.5, detail: 8 });
    // Paper lanterns under the front eaves, at the posts.
    for (const x of [-0.75, 2.25]) {
      b.cyl(0.004, 0.3, [x, 2.05, 1.86], '#3a3331', { sides: 4 });
      lantern(b, [x, 1.78, 1.86], { kind: 'paper', light: '#ffb86a' });
    }
    // Chillies and garlic hung from the plate by the kitchen; behind, firewood stacked under the eaves and a jar; the
    // 지게 left against the west end.
    hanging(b, [-2.08, 2.17, 1.55], 0.7, 'pepper');
    hanging(b, [-0.92, 2.17, 1.55], 0.62, 'pepper');
    hanging(b, [-0.55, 2.17, 1.55], 0.48, 'garlic');
    stack(b, [-0.9, 0, -2.25], 2.0, 0.85, 0, 0.36);
    jar(b, [0.85, 0, -2.2], 0.8, '#6b4a35');
    jige(b, [-2.48, 0.36, -0.55], WEST);
  },
  trees: (b, yard) => {
    tree(b, yard.at([4.3, -2.3], [5.4, -2.9]), { height: 4.2, spread: 3.3, bark: '#4f4036', leaves: ['#8fae4f', '#a8b85a', '#c9a84a', '#7a9c45'], lobes: 5, density: 0.8, fruit: '#f08a2a' });
    tree(b, yard.at([-2.2, 4.4], [-2.8, 5.6]), { height: 3.3, spread: 2.6, bark: '#5a4636', leaves: ['#6f9a48', '#85ab55', '#5d8840'], lobes: 4 });
    bush(b, yard.at([4.4, 2.2], [5.3, 2.5]), 0.45, GREENS);
  },
  garden: (b, site) => {
    const timber = '#5a3f2c';
    const jars: V3 = [-3.6, 0, 3.5];
    site.keep(HOUSE[0], HOUSE[2] + 0.3, 2.9, 2.75).keep(jars[0], jars[2], 1.35, 1.05).keep(3.55, -2.9, 1.4, 1.0);
    // 장독대.
    b.group(jars, () => {
      b.box([2.5, 0.2, 1.9], [0, 0.1, 0], '#ffffff', MASONRY);
      for (const [x, z, scale, color] of [[-0.7, -0.4, 1.5, '#5b3d2c'], [0.1, -0.45, 1.25, '#6b4a35'], [0.8, -0.25, 1.05, '#4f3527'], [-0.45, 0.45, 0.95, '#6b4a35'], [0.25, 0.5, 0.8, '#5b3d2c'], [0.85, 0.45, 0.62, '#4f3527'], [-0.9, 0.25, 0.6, '#5b3d2c']] as const) jar(b, [x, 0.2, z], scale, color);
    });

    // 돌담 round the back, tiled along its top, open where the bridges land.
    const wall: Palette = ['#b7ad9d', '#a39988', '#c7bdac', '#958b7b'];
    stoneWall(b, [-4.4, -5.9], [-0.95, -5.9], 0.55, wall, '#7a6652');
    stoneWall(b, [0.95, -5.9], [3.6, -5.9], 0.55, wall, '#7a6652');
    stoneWall(b, [-5.9, -4.4], [-5.9, -0.95], 0.55, wall, '#7a6652');

    // 텃밭: cabbages, chillies and spring onions in their rows, pumpkins at its edge, a rick of straw.
    for (const [row, z] of [-3.55, -2.9, -2.25].entries()) {
      b.box([2.3, 0.13, 0.4], [3.55, 0.045, z], '#5f4330', { surface: 'soil', rough: 1 });
      for (let plant = 0; plant < 7; plant++) {
        const x = 2.6 + plant * 0.32;
        if (row === 1) {
          b.sprig('puff', [x, 0.21, z], [0.22, 0.16, 0.22], '#b5d68a');
          for (let leaf = 0; leaf < 3; leaf++) b.sprig('leaf', [x, 0.14, z], 0.32, b.pick(['#8fbf6a', '#7aae5c']), [Math.cos(leaf * 2.1) * 0.6, 0.6, Math.sin(leaf * 2.1) * 0.6], leaf * 2, [0, 1, 0]);
        } else if (row === 0) {
          b.sprig('leaf', [x, 0.24, z], [0.28, 0.38, 0.28], b.pick(GREENS), [0, 1, 0], plant, [0, 1, 0]);
          for (let pod = 0; pod < 3; pod++) b.sprig('puff', [x + b.between(-0.08, 0.08), 0.2 + b.between(0, 0.12), z + b.between(-0.08, 0.08)], [0.035, 0.1, 0.035], '#d6362a');
        } else {
          for (let blade = 0; blade < 4; blade++) b.sprig('frond', [x + b.between(-0.04, 0.04), 0.1, z + b.between(-0.04, 0.04)], [0.5, b.between(0.36, 0.52), 0.5], b.pick(['#7fb35a', '#93c26a']), [b.between(-0.2, 0.2), 1, b.between(-0.2, 0.2)], b.between(0, TAU));
        }
      }
    }
    for (const [x, z, size] of [[5.1, -1.35, 0.36], [4.75, -1.05, 0.26]] as const) {
      b.sprig('puff', [x, size * 0.36, z], [size, size * 0.72, size], '#e88a2c');
      for (let leaf = 0; leaf < 4; leaf++) b.sprig('leaf', [x + b.between(-0.3, 0.3), 0.06, z + b.between(-0.3, 0.3)], 0.34, b.pick(GREENS), [0, 1, 0], leaf);
    }
    b.cone(0.6, 1.1, [4.2, 0.55, -4.7], '#d2b060', { surface: 'thatch', rough: 1, sides: 20 });
    b.cone(0.26, 0.36, [4.2, 1.16, -4.7], '#b99a52', { surface: 'thatch', rough: 1, sides: 14 });
    // Chillies drying on a mat in the yard.
    b.cyl(0.55, 0.02, [0.7, 0.015, 4.8], '#d9c07a', { sides: 24, surface: 'thatch', rough: 1, shadowless: true });
    for (let pod = 0; pod < 44; pod++) {
      const angle = b.between(0, TAU);
      const away = Math.sqrt(b.random()) * 0.46;
      b.sprig('puff', [0.7 + Math.cos(angle) * away, 0.04, 4.8 + Math.sin(angle) * away], [0.03, 0.03, 0.1], b.pick(['#d6362a', '#c22a22', '#e04a34']), [0, 1, 0], b.between(0, TAU));
    }

    tree(b, [2.6, 0, -5.4], { height: 3.6, spread: 2.8, bark: '#4f4036', leaves: ['#8fae4f', '#a8b85a', '#c9a84a', '#7a9c45'], lobes: 4, density: 0.8, fruit: '#f08a2a' });
    // A low platform of boards to sit out on.
    b.box([1.3, 0.06, 0.85], [-4.3, 0.3, 1.55], '#a67c52', { ...WOOD, vary: 0.05 });
    for (const [x, z] of [[-4.85, 1.22], [-3.75, 1.22], [-4.85, 1.88], [-3.75, 1.88]] as const) b.box([0.07, 0.28, 0.07], [x, 0.14, z], timber, WOOD);
    lantern(b, [-1.7, 0, 5.1], { kind: 'stone' });
    lantern(b, [-5.3, 0, 2.4], { kind: 'stone' });
    flowerBed(b, [-5.0, -2.2], [0.3, 1.6], 26, ['#f06a8a', '#ff9fb5', '#d93a5a', '#ffffff'], { height: [0.2, 0.42] });
    flowerBed(b, [3.0, 5.3], [0.9, 0.45], 26, ['#ffb7d0', '#ffffff', '#f48fb1', '#e86a9a'], { height: [0.22, 0.46], keep: (x, z) => Math.hypot(x - KEEPSAKE_AT[0], z - KEEPSAKE_AT[2]) > 0.75 });
    steppingStones(b, [[-0.3, 3.3], [-0.25, 4.5], [0, 5.7]], 0.5, ['#b7ad9d', '#a39988']);
    b.life({ kind: 'butterfly', at: [3.0, 0.7, 5.2], color: '#fff3b0', phase: 1 });
    b.life({ kind: 'fireflies', at: [-4.9, 0.5, -1.9], reach: 1.2, count: 5 });
  },
};

/** 금: 기와집, white walls between dark posts under grey tiles, a court of raked gravel and a pine. */
const metal: Plan = {
  ground: { lawn: ['#6a9658', '#80a866', '#98b878'], dirt: '#8a7d6a', bank: '#a9a59c', yard: '#d8d5cb', rocks: ['#b9b6ad', '#a5a39b', '#cac7be'] },
  bare: { neighbour: [], home: [[-2.9, 3.6, 2.1, 1.8]] },
  house: (b, full) => {
    const timber = '#4a372d';
    const white = '#f3efe6';
    const giwa: Cover = { kind: 'barrel', tiles: ['#4f5661', '#59606b', '#474d57', '#626a75'], pan: '#30343b', rough: 0.55, lift: 0.36, caps: '#6b727d', pitch: 0.22 };
    // 기단 of dressed stone, and its steps before and behind.
    b.box([5.2, 0.32, 4.3], [0, 0.16, 0], '#d8d4ca', STONE);
    steps(b, [DOOR_X, 0, 2.55], 1.3, 2, { rise: 0.16, tread: 0.2, color: '#d8d4ca' });
    steps(b, [1.0, 0, -2.55], 1.0, 2, { rise: 0.16, tread: 0.2, color: '#d8d4ca' }, BACK);
    b.box([4.3, 1.6, 3.3], [0, 1.12, 0], white, { surface: 'plaster', rough: 0.92 });
    b.box([4.32, 0.3, 3.32], [0, 0.48, 0], '#6b4a35', WOOD);
    for (const [x, z] of [[-2.15, 1.65], [0, 1.65], [2.15, 1.65], [2.15, 0], [2.15, -1.65], [0, -1.65], [-2.15, -1.65], [-2.15, 0]] as const) b.cyl(0.095, 1.68, [x, 1.16, z], timber, { sides: 14, surface: 'wood' });
    b.box([4.6, 0.17, 3.6], [0, 2.0, 0], timber, WOOD);
    b.box([4.45, 0.08, 3.45], [0, 1.72, 0], timber, WOOD);
    paper(b, [DOOR_X + 0.07, 1.1, 1.66], [1.5, 1.12], timber, 0, 3);
    paper(b, [-1.1, 1.22, 1.66], [1.5, 0.78], timber, 0, 3);
    for (const side of [1, -1]) for (const z of [0.82, -0.82]) paper(b, [side * 2.16, 1.22, z], [1.1, 0.76], timber, side * QUARTER, 2);
    // The back: a door of two leaves onto its steps, and a window of three.
    paper(b, [1.0, 1.1, -1.66], [1.0, 1.12], timber, BACK, 2);
    paper(b, [-1.05, 1.22, -1.66], [1.5, 0.78], timber, BACK, 3);
    b.box([4.2, 0.07, 0.72], [0, 0.5, 2.02], '#8f6a48', { ...WOOD, vary: 0.05 });
    for (const x of [-1.9, -0.6, 0.7, 2.0]) b.box([0.1, 0.18, 0.1], [x, 0.41, 2.3], timber, WOOD);

    // 기와지붕: the eaves lifting to their corners, a white-pointed ridge, its ends turned up, rafters under both eaves.
    gableRoof(b, [0, 2.08, 0], { width: 4.5, depth: 3.5, rise: 1.45, over: 0.62, verge: 0.36, both: true, cover: giwa, wall: white, wallFinish: { surface: 'plaster' }, trim: timber, ridge: '#454b54' });
    b.box([5.3, 0.07, 0.24], [0, 3.56, 0], '#e9e5db', { surface: 'plaster' });
    b.box([5.3, 0.14, 0.2], [0, 3.66, 0], '#3d424a', { surface: 'clay', rough: 0.6 });
    for (const end of [-1, 1]) b.box([0.14, 0.34, 0.24], [end * 2.68, 3.72, 0], '#3d424a', { surface: 'clay', rough: 0.6 }, [0, 0, end * -0.3]);
    for (const side of [1, -1]) {
      for (let rafter = 0; rafter < 15; rafter++) b.cyl(0.035, 0.6, [-2.25 + rafter * 0.32, 1.84, side * 2.02], '#6b4a35', { sides: 8, surface: 'wood' }, [side * (QUARTER + 0.62), 0, 0]);
    }
    // 굴뚝: brick and tile, standing off the wall, its own small roof over it.
    b.box([0.46, 1.9, 0.46], [2.85, 0.95, -1.25], '#cfc8bb', MASONRY);
    for (const y of [0.5, 1.05, 1.6]) b.box([0.5, 0.05, 0.5], [2.85, y, -1.25], '#4f5661', { surface: 'clay', rough: 0.6 });
    b.prism([0.7, 0.2, 0.7], [2.85, 1.9, -1.25], '#4f5661', { surface: 'clay', rough: 0.6, ridge: 0 });
    if (!full) return;

    b.life({ kind: 'smoke', at: [2.85, 2.15, -1.25], scale: 0.7 });
    // 풍경 under the eaves' corners.
    for (const x of [-2.5, 2.5]) {
      for (const z of [2.3, -2.3]) {
        b.cyl(0.004, 0.2, [x, 1.86, z], '#55585f', { sides: 4 });
        b.cyl(0.055, 0.09, [x, 1.72, z], '#c79a4a', { top: 0.03, metal: 0.9, rough: 0.3, sides: 12 });
        b.box([0.06, 0.09, 0.006], [x, 1.58, z], '#c9d3e6', { metal: 0.8, rough: 0.3 }, [0, 0.6, 0]);
      }
    }
    lantern(b, [-2.2, 0, 2.6], { kind: 'stone', light: '#ffe2b0' });
    // Shoes left on the back step.
    for (const x of [0.85, 1.05]) b.ball(0.04, [x, 0.345, -2.25], '#f6f2ea', { scale: [0.8, 0.5, 1.7], rough: 0.5, detail: 8 });
  },
  trees: (b, yard) => {
    pine(b, yard.at([4.3, -2.3], [5.4, -2.9]), { height: 4.7, spread: 3.4, needles: ['#3f6b4a', '#4a7a55', '#335c40', '#5a8a62'] });
    bamboo(b, yard.at([-4.3, 2.2], [-5.6, 2.3]), { canes: 11, height: 4.0, reach: 0.6 });
    bush(b, yard.at([4.4, 2.2], [5.3, 2.5]), 0.42, ['#3f7a4a', '#4d8a56', '#366b40'], { colors: ['#ffffff', '#fbe9f0'], count: 15 }, 0.7);
  },
  garden: (b, site) => {
    const court: V3 = [-2.9, 0, 3.6];
    site.keep(HOUSE[0], HOUSE[2] + 0.35, 2.95, 2.65);
    // The court: gravel raked in rings about a pagoda of stone.
    b.group(court, () => {
      b.cyl(1.75, 0.03, [0, 0.012, 0], '#e4e1d8', { sides: 48, surface: 'gravel', rough: 0.95, shadowless: true });
      for (const radius of [0.75, 1.05, 1.35, 1.62]) b.ring(radius, 0.016, [0, 0.03, 0], '#cbc8bf', { rough: 0.95, shadowless: true }, [QUARTER, 0, 0]);
      b.box([0.6, 0.12, 0.6], [0, 0.06, 0], '#cfcbc1', STONE);
      let y = 0.12;
      for (const [body, roof] of [[0.36, 0.56], [0.29, 0.46], [0.22, 0.36]] as const) {
        b.box([body, body * 0.72, body], [0, y + body * 0.36, 0], '#d8d4ca', STONE);
        y += body * 0.72;
        b.prism([roof, 0.1, roof], [0, y, 0], '#bcb8ae', { ...STONE, ridge: 0 });
        b.box([roof * 0.5, 0.03, roof * 0.5], [0, y + 0.08, 0], '#cfcbc1', STONE);
        y += 0.1;
      }
      b.cyl(0.03, 0.2, [0, y + 0.1, 0], '#bcb8ae', { ...STONE, sides: 8 });
      b.ball(0.045, [0, y + 0.22, 0], '#bcb8ae', { ...STONE, detail: 8 });
      for (const [x, z, size] of [[-1.15, 0.65, 0.5], [1.0, -0.75, 0.36], [-0.75, -0.95, 0.3]] as const) rock(b, [x, 0, z], size, b.pick(['#8f9299', '#a1a4aa', '#7e8188']), 0.85);
      lantern(b, [-1.55, 0, 1.05], { kind: 'stone', light: '#ffe2b0' });
      lantern(b, [1.65, 0, 1.5], { kind: 'stone', light: '#ffe2b0' });
    });

    // Behind: birches beyond the chimney, a small pine among stones by the corner, a wall tiled along its top.
    birch(b, [2.5, 0, -5.6], { height: 3.9, leaves: ['#c2db8a', '#d3e6a0', '#aecb78'] });
    birch(b, [3.8, 0, -4.5], { height: 3.3, leaves: ['#c2db8a', '#d3e6a0', '#aecb78'] });
    stoneWall(b, [-4.0, -5.6], [-0.95, -5.6], 0.5, ['#b9b6ad', '#a5a39b', '#cac7be'], '#4f5661');
    pine(b, [-3.9, 0, -4.9], { height: 1.9, spread: 1.5, needles: ['#3f6b4a', '#4a7a55', '#335c40'] });
    for (const [x, z, size] of [[-1.85, -4.8, 0.42], [-2.95, -4.75, 0.3], [-5.3, -2.2, 0.36]] as const) rock(b, [x, 0, z], size, b.pick(['#8f9299', '#a1a4aa', '#7e8188']), 0.85);
    for (const [x, z, radius, blooms] of [[-4.4, 1.3, 0.42, ['#ffffff', '#fbe9f0']], [-3.3, 1.2, 0.36, ['#f7a8c4', '#fbd0de']], [1.55, 0.95, 0.4, ['#ffffff', '#fbe9f0']], [5.3, -1.1, 0.5, ['#f7a8c4', '#e87aa4']], [-5.3, -1.0, 0.4, ['#f7a8c4', '#fbd0de']]] as const) {
      bush(b, [x, 0, z], radius, ['#3f7a4a', '#4d8a56', '#366b40'], { colors: blooms, count: Math.round(radius * 36) }, 0.7);
    }
    for (let slab = 0; slab < 9; slab++) {
      const t = slab / 8;
      b.box([0.56, 0.05, 0.36], [-0.3 + Math.sin(t * 2.4) * 0.14 + t * 0.28, 0.02, 1.5 + t * 4.2], b.pick(['#cfcbc1', '#c2beb4', '#d8d4ca']), { ...STONE, vary: 0.04 }, [0, b.between(-0.08, 0.08), 0]);
    }
    lantern(b, [-0.9, 0, 2.3], { kind: 'path', light: '#ffe2b0', frame: '#3a3d45' });
    lantern(b, [0.5, 0, 4.3], { kind: 'path', light: '#ffe2b0', frame: '#3a3d45' });
    b.life({ kind: 'fireflies', at: [-3.0, 0.9, -4.9], reach: 1.2, count: 6 });
  },
};

const BLUE_TILES: Cover = { kind: 'barrel', tiles: ['#2f6db3', '#3a7fc6', '#285f9e', '#4a8fd2'], pan: '#1f3f66', rough: 0.36 };
const HYDRANGEA: Palette = ['#7f9cf0', '#9aa8f5', '#b79cf0', '#6f8ae0', '#a9c0f7'];
const WISTERIA: Palette = ['#b79cf0', '#c9b2f7', '#9f84e0'];

/** 수: white walls under a roof of blue tiles, a garden room of glass, and a pond with its bridge. */
const water: Plan = {
  ground: { lawn: ['#5c984d', '#72aa5a', '#8aba6a'], dirt: '#7d6a52', bank: '#9aa0a0', rocks: ['#8f979c', '#a3aaae', '#7c858b'] },
  ponds: { neighbour: [{ x: -2.75, z: 2.95, rx: 1.6, rz: 1.25 }], home: [{ x: -3.2, z: 3.4, rx: 1.6, rz: 1.25 }] },
  house: (b, full) => {
    const white = '#f4efe6';
    const trim = '#e9e2d4';
    const dark = '#3a4a5e';
    const shutter = '#4f7396';
    const hood = (x: number, z: number) => {
      gableRoof(b, [x, 1.52, z], { width: 0.6, depth: 1.2, rise: 0.36, over: 0.14, verge: 0.12, both: true, cover: BLUE_TILES, wall: white, wallFinish: { surface: 'plaster' }, trim: dark }, QUARTER);
      for (const side of [-0.5, 0.5]) b.box([0.05, 0.05, 0.62], [x + side, 1.36, z], dark, WOOD, [Math.sign(z) * 0.6, 0, 0]);
    };
    b.box([4.5, 0.2, 3.6], [0, 0.1, 0], '#ffffff', MASONRY);
    b.box([4.3, 2.72, 3.4], [0, 1.56, 0], white, { surface: 'plaster', rough: 0.92 });
    b.box([4.36, 0.07, 3.46], [0, 1.62, 0], trim, STONE);
    gableRoof(b, [0, 2.92, 0], { width: 4.3, depth: 3.4, rise: 1.25, over: 0.38, verge: 0.26, both: true, cover: BLUE_TILES, wall: white, wallFinish: { surface: 'plaster' }, trim: dark });
    for (const side of [1, -1]) windowAt(b, [side * 2.151, 3.45, 0], { size: [0.4, 0.4], frame: trim, bars: [2, 2], arch: true }, side * QUARTER);
    chimney(b, [-1.4, 3.3, -0.7], [0.5, 0.5], 1.3, { surface: 'plaster', color: white, cap: '#3a7fc6' });

    // The door under its own little roof, and the windows.
    doorAt(b, [DOOR_X, 0.2, 1.701], { size: [0.56, 1.08], color: '#2f5f96', frame: trim, transom: true });
    hood(DOOR_X, 2.0);
    steps(b, [DOOR_X, 0, 2.32], 1.2, 3, { rise: 0.066, tread: 0.2, color: '#d5d3cc' });
    windowAt(b, [DOOR_X, 2.2, 1.701], { size: [0.62, 0.92], frame: trim, bars: [2, 3] });
    railing(b, [DOOR_X - 0.45, 1.66, 1.83], [DOOR_X + 0.45, 1.66, 1.83], { color: '#2b2e36', height: 0.36 });
    windowAt(b, [-1.2, 2.2, 1.701], { size: [0.6, 0.72], frame: trim, bars: [2, 2], sill: trim, shutters: shutter });
    // The east and the west alike: a shuttered window below with its box of flowers, two above.
    for (const side of [1, -1]) {
      windowAt(b, [side * 2.151, 0.98, side * 0.6], { size: [0.8, 0.72], frame: trim, bars: [2, 2], sill: trim, shutters: shutter, ...(full ? { flowers: HYDRANGEA } : {}) }, side * QUARTER);
      for (const z of [0.75, -0.6]) windowAt(b, [side * 2.151, 2.2, side * z], { size: [0.5, 0.66], frame: trim, bars: [2, 2], sill: trim, shutters: shutter }, side * QUARTER);
    }
    // The back: a door under a hood of its own, a window beside it, two above, the rain led down the corner.
    doorAt(b, [-1.05, 0.2, -1.701], { size: [0.56, 1.06], color: '#2f5f96', frame: trim }, BACK);
    hood(-1.05, -2.0);
    steps(b, [-1.05, 0, -2.32], 1.0, 3, { rise: 0.066, tread: 0.2, color: '#d5d3cc' }, BACK);
    windowAt(b, [0.95, 0.98, -1.701], { size: [0.8, 0.72], frame: trim, bars: [2, 2], sill: trim, shutters: shutter }, BACK);
    for (const x of [-1.05, 0.95]) windowAt(b, [x, 2.2, -1.701], { size: [0.5, 0.66], frame: trim, bars: [2, 2], sill: trim, shutters: shutter }, BACK);
    downpipe(b, 1.95, 2.58, -2.16, -1.7, full);

    // The garden room: glass on a low wall on three sides, lit from inside, a deck before it reaching the pond.
    b.box([1.9, 0.3, 1.0], [-1.2, 0.35, 2.2], white, { surface: 'plaster' });
    b.pane([1.8, 0.95], [-1.2, 0.98, 2.701], 'room', 2.3);
    for (const side of [1, -1]) b.pane([0.95, 0.95], [-1.2 + side * 0.951, 0.98, 2.2], 'room', 2.3, side * QUARTER);
    for (const x of [-2.12, -1.52, -0.9, -0.28]) b.box([0.045, 1.0, 0.045], [x, 0.98, 2.71], trim, WOOD);
    for (const x of [-2.16, -0.24]) for (const z of [1.72, 2.2]) b.box([0.045, 1.0, 0.045], [x, 0.98, z], trim, WOOD);
    for (const y of [0.5, 1.47]) {
      b.box([1.9, 0.05, 0.05], [-1.2, y, 2.71], trim, WOOD);
      for (const x of [-2.16, -0.24]) b.box([0.05, 0.05, 1.0], [x, y, 2.2], trim, WOOD);
    }
    b.group([-1.2, 1.48, 1.7], () => slope(b, 2.0, 1.06, 0.34, { kind: 'plain', color: '#9fc4d6' }));
    for (const x of [-2.15, -1.52, -0.9, -0.25]) b.box([0.04, 0.04, 1.12], [x, 1.69, 2.22], trim, WOOD, [0.31, 0, 0]);
    b.box([2.2, 0.06, 0.8], [-1.2, 0.09, 3.12], '#a98a68', { ...WOOD, vary: 0.05 });
    if (!full) return;

    b.life({ kind: 'smoke', at: [-1.4, 4.9, -0.7], scale: 0.9 });
    lantern(b, [DOOR_X + 0.5, 1.0, 1.701], { kind: 'wall', light: '#ffd9a0' });
    lantern(b, [-0.55, 1.0, -1.701], { kind: 'wall', light: '#ffd9a0' }, BACK);
    // Wisteria up the corners and the walls, hydrangeas by the door.
    b.group([0.15, 0.2, 1.71], () => vine(b, [0, 0, 0], 0.55, 2.5, GREENS, { colors: WISTERIA, share: 0.4 }, 1.4));
    b.group([2.16, 0.2, 0], () => vine(b, [1.35, 0, 0], 0.6, 2.4, GREENS, { colors: WISTERIA, share: 0.4 }, 1.3), QUARTER);
    b.group([-2.16, 0.2, 0], () => vine(b, [1.38, 0, 0], 0.5, 2.4, GREENS, { colors: WISTERIA, share: 0.4 }, 1.3), WEST);
    b.group([0, 0.2, -1.71], () => vine(b, [-0.05, 0, 0], 0.5, 2.3, GREENS, { colors: WISTERIA, share: 0.4 }, 1.3), BACK);
    pot(b, [DOOR_X - 0.85, 0, 2.2], 1, GREENS, HYDRANGEA, '#e9eef5');
    pot(b, [DOOR_X + 0.85, 0, 2.2], 1, GREENS, ['#ffffff', '#f4f7ff'], '#e9eef5');
  },
  trees: (b, yard) => {
    const blossom: Palette = ['#f7bfd0', '#f9d0dc', '#f2a9c0', '#fbe3ea'];
    // 벚나무 in full flower.
    tree(b, yard.at([4.3, -2.3], [5.4, -2.8]), { height: 4.5, spread: 4.0, bark: '#4a3a36', leaves: blossom, lobes: 6, flat: 0.68, blooms: { colors: ['#ffe9f0', '#f9c4d4', '#ffffff'], share: 0.4 } });
    // The willow by the pond: on a neighbour's smaller island it stands south of it, its strands short of the landings.
    willow(b, yard.at([-2.1, 4.45], [-5.5, 2.9]), { height: 4.1, spread: yard.kind === 'home' ? 3.0 : 2.6, leaves: ['#8fbf5a', '#a3cc68', '#7cae4c', '#b5d67a'] });
    bush(b, yard.at([4.4, 2.2], [5.3, 2.5]), 0.5, GREENS, { colors: HYDRANGEA, count: 13, kind: 'puff', size: 0.17 });
  },
  garden: (b, site) => {
    const pond = site.ponds[0]!;
    const stones: Palette = ['#8f979c', '#a3aaae', '#7c858b'];
    const cherry: V3 = [5.4, 0, -2.8];
    const table: V3 = [3.8, 0, -1.85];
    site.keep(HOUSE[0], HOUSE[2] + 0.3, 2.7, 2.45).keep(-0.4, 1.3, 1.1, 0.9).keep(table[0], table[2], 0.95, 0.95).keep(1.4, -5.0, 0.7, 0.7);
    // The pond: stones about it, lilies and carp in it, irises at its edge, a red bridge over it.
    const bridge = pond.z + 0.15;
    const onBridge = (x: number, z: number) => Math.abs(z - bridge) < 0.45 || (Math.abs(x - pond.x - 0.15) < 1.2 && z < pond.z - 0.95);
    dressPond(b, pond, stones, onBridge);
    lilies(b, [pond.x + 0.1, pond.z - 0.15], WATER_LEVEL, [1.05, 0.5], 9);
    lilies(b, [pond.x - 0.2, pond.z + 0.72], WATER_LEVEL, [0.95, 0.25], 6);
    b.life({ kind: 'koi', at: [pond.x, 0, pond.z - 0.35], reach: 0.75, color: '#ff8a3d', phase: 0 });
    b.life({ kind: 'koi', at: [pond.x + 0.2, 0, pond.z - 0.3], reach: 0.5, color: '#f6f2ea', phase: 2.6 });
    b.life({ kind: 'koi', at: [pond.x - 0.3, 0, pond.z + 0.6], reach: 0.4, color: '#e04a2a', phase: 4.4 });
    b.life({ kind: 'ripples', at: [pond.x - 0.7, WATER_LEVEL, pond.z - 0.5], reach: 0.5 });
    reeds(b, [pond.x - 1.45, WATER_LEVEL - 0.05, pond.z + 0.35], 12, 0.3);
    flowerBed(b, [pond.x + 1.75, pond.z + 0.9], [0.3, 0.6], 20, ['#7a5fd0', '#9a7fe8', '#5f4fb8'], { height: [0.3, 0.5], leaves: ['#5f9a50', '#4f8a45'] });
    const span = 3.5;
    const deck = (t: number): V3 => [pond.x - 1.75 + span * t, 0.04 + Math.sin(t * Math.PI) * 0.46, bridge];
    const red = '#8f4a36';
    for (let plank = 0; plank < 22; plank++) {
      const t = (plank + 0.5) / 22;
      b.box([span / 22 - 0.012, 0.035, 0.52], deck(t), b.pick(['#9a5540', '#8f4a36', '#a35f48']), { ...WOOD, vary: 0.06 }, [0, 0, Math.atan((0.46 * Math.PI * Math.cos(t * Math.PI)) / span)]);
    }
    for (const side of [-1, 1]) {
      const along = (lift: number) => Array.from({ length: 13 }, (_, index): V3 => [deck(index / 12)[0], deck(index / 12)[1] + lift, bridge + side * 0.25]);
      b.limb(along(-0.03), [0.035], red, { ...WOOD, sides: 6 });
      b.limb(along(0.36), [0.022], red, { ...WOOD, sides: 6 });
      b.limb(along(0.19), [0.014], red, { ...WOOD, sides: 5 });
      for (let post = 0; post <= 6; post++) {
        const at = deck(post / 6);
        b.box([0.045, 0.42, 0.045], [at[0], at[1] + 0.19, bridge + side * 0.25], red, WOOD);
        if (post === 0 || post === 6) b.ball(0.035, [at[0], at[1] + 0.42, bridge + side * 0.25], red, { ...WOOD, detail: 8 });
      }
    }

    // Petals coming down from the cherry; a table set out under it.
    const blossom: Palette = ['#f7bfd0', '#f9d0dc', '#f2a9c0', '#fbe3ea'];
    b.life({ kind: 'petals', at: [cherry[0] - 0.15, 3.4, cherry[2] + 0.4], reach: 1.9, color: '#fbd0de' });
    for (let petal = 0; petal < 90; petal++) {
      const angle = b.between(0, TAU);
      const away = Math.sqrt(b.random()) * 2.6;
      const x = cherry[0] + Math.cos(angle) * away;
      const z = cherry[2] + Math.sin(angle) * away * 0.9;
      if (site.shore(x, z) > 0.5) b.sprig('pad', [x, 0.03, z], b.between(0.04, 0.07), b.pick(blossom), [0, 1, 0], b.between(0, TAU));
    }
    b.cyl(0.92, 0.04, [table[0], 0.012, table[2]], '#ffffff', { sides: 32, surface: 'masonry', rough: 0.9, shadowless: true });
    tableSet(b, [table[0], 0.03, table[2]], 3, { turn: 0.4 });
    parasol(b, [table[0], 0.03, table[2]], '#f1e7d6');
    lantern(b, [table[0] + 0.35, 0.42, table[2] + 0.1], { kind: 'paper', light: '#ffd9a0', power: 0.7 });
    // Behind: the well, a tree beyond it, a small one by the corner.
    well(b, [1.4, 0, -5.0], { cover: BLUE_TILES }, 0.25);
    tree(b, [3.3, 0, -5.3], { height: 3.4, spread: 2.7, bark: '#5a4a3e', leaves: ['#7cc0a0', '#8fd0ae', '#68ad8e'], lobes: 4 });
    tree(b, [-4.75, 0, -4.5], { height: 2.9, spread: 2.2, bark: '#5a4a3e', leaves: ['#6fb07a', '#82c08a', '#5c9c68', '#98cf9c'], lobes: 4 });
    for (const [x, z, radius] of [[1.25, 0.8, 0.44], [-0.9, 5.1, 0.4], [5.2, -1.1, 0.42], [-5.3, -1.6, 0.4]] as const) {
      bush(b, [x, 0, z], radius, GREENS, { colors: HYDRANGEA, count: Math.round(radius * 26), kind: 'puff', size: 0.17 });
    }
    flowerBed(b, [0.7, 4.1], [0.4, 1.0], 24, ['#ffffff', '#cfe0ff', '#9aa8f5', '#f4f7ff'], { keep: (x, z) => Math.hypot(x - GUARDIAN_AT[0], z - GUARDIAN_AT[2]) > 0.8 });
    path(b, [-0.3, 2.45], ['#b6bcc0', '#a3aaae', '#c5cace'], '#ffd9a0');
    jetty(b, [-6.15, 0.03, -2.1], 1.8, 0.62, { wood: '#8f7a62' }, WEST);
    boat(b, [-7.75, WATER_LEVEL, -3.05], 0.25, '#6b4a35');
    b.life({ kind: 'ripples', at: [-7.6, WATER_LEVEL, -2.7], reach: 0.9 });
    b.life({ kind: 'fireflies', at: [-4.1, 0.6, 1.6], reach: 1.2, count: 6 });
    b.life({ kind: 'butterfly', at: [0.7, 0.7, 4.1], color: '#cfe0ff', phase: 0.6 });
  },
};

const PLANS: Record<Element, Plan> = { wood, fire, earth, metal, water };

/** The ground about a house of `style`: its lawn's greens, its earth, its bank and stones. */
export const groundOf = (style: Element): GroundLook => PLANS[style].ground;
/** How thickly a garden is planted for a device that would labour over a full one (a phone). */
const THIN = 0.62;

/**
 * A home's island with its house built, every side of it. With its whole garden (`home`) the chart's symbol and
 * keepsake stand in their places about it, on the island of {@link GARDEN}; a neighbour's keeps the house, the ground
 * and shore and a few trees. The page's own island is an estate laid out about the house alone (see buildHouse).
 */
export function buildHome(house: Pick<House, 'style' | 'accent' | 'symbol'>, lush = true, kind: IslandKind = 'home'): Build {
  const plan = PLANS[house.style];
  const full = kind === 'home';
  const shape = GARDENS[kind];
  const b = new Builder(SEED[house.style]);
  if (!lush) b.density = THIN;
  const site = new Site(SEED[house.style], plan.ponds?.[kind] ?? [], shape);
  for (const [x, z, rx, rz] of plan.bare?.[kind] ?? []) site.bare(x, z, rx, rz);
  ground(b, site, plan.ground, GARDEN_STEPS[kind]);
  b.group(HOUSE, () => plan.house(b, full));
  plan.trees(b, yardOf(kind));
  if (full) {
    plan.garden(b, site);
    site.keep(GUARDIAN_AT[0], GUARDIAN_AT[2], 0.7).keep(EMBLEM_AT[0], EMBLEM_AT[2], house.symbol === 'tree' ? 0.7 : 1.05).keep(KEEPSAKE_AT[0], KEEPSAKE_AT[2], 0.55);
    emblem(b, house.symbol, EMBLEM_AT);
    if (house.accent) keepsake(b, house.accent, KEEPSAKE_AT);
  }
  dressShore(b, site, plan.ground, landing(shape, BRIDGE_WAY.stones), { ...(full ? {} : LIGHT_SHORE), reedless: landing(shape, BRIDGE_WAY.reeds) });
  return b.finish();
}

/**
 * The house alone, about its own middle, every side of it and what is small about it (pots, flowers, lamps, smoke):
 * what stands at the heart of the page's own island, whose estate is laid out about it (see Estate).
 */
export function buildHouse(house: Pick<House, 'style'>, lush = true): Build {
  const b = new Builder(SEED[house.style]);
  if (!lush) b.density = THIN;
  PLANS[house.style].house(b, true);
  return b.finish();
}

const LOT: GroundLook = { lawn: ['#739a40', '#8db04e', '#a6bf60'], dirt: '#8b6b4b', bank: '#a89a82', rocks: ['#a39788', '#b7ab9b', '#8e8377'] };

/**
 * A plot nobody has built on: the island as it was found, stakes and a line marking the house to come, a board. The
 * page's own (`home`) is as large as the estate it will be.
 */
export function buildLot(lush = true, kind: IslandKind = 'home'): Build {
  const yard = yardOf(kind);
  const shape = ISLANDS[kind];
  const b = new Builder(71);
  if (!lush) b.density = THIN;
  const site = new Site(71, [], shape);
  ground(b, site, LOT, GROUND_STEP[kind]);
  for (const [x, z] of [[-2.6, -2.6], [2.6, -2.6], [2.6, 2.6], [-2.6, 2.6]] as const) b.box([0.06, 0.5, 0.06], [x, 0.25, z], '#a98458', WOOD);
  for (const [x, z, wide, deep] of [[0, -2.6, 5.2, 0.015], [0, 2.6, 5.2, 0.015], [-2.6, 0, 0.015, 5.2], [2.6, 0, 0.015, 5.2]] as const) b.box([wide, 0.015, deep], [x, 0.42, z], '#f3e6cf', { shadowless: true });
  // The board on its post, braced from behind: a sign is seen from every side.
  b.group(
    [0, 0, 0.2],
    () => {
      b.box([0.07, 1.1, 0.07], [0, 0.55, 0], '#7a5a42', WOOD);
      b.box([1.1, 0.6, 0.05], [0, 1.0, 0.06], '#e9dcc0', WOOD);
      b.box([1.16, 0.04, 0.06], [0, 1.31, 0.06], '#7a5a42', WOOD);
      b.box([0.045, 0.75, 0.045], [0, 0.36, -0.2], '#7a5a42', WOOD, [0.62, 0, 0]);
    },
    Math.PI / 4,
  );
  tree(b, yard.at([-4.3, -2.3], [-5.5, -2.6]), { height: 3.4, spread: 2.8, bark: '#5f4a3a', leaves: ['#5f9a4a', '#6fab55', '#4f8a40', '#84b95f'] });
  bush(b, yard.at([4.3, -2.3], [5.5, -2.6]), 0.55, GREENS, { colors: ['#ffd95a', '#fff0a0'], count: 12 });
  if (kind === 'home') {
    tree(b, [2.6, 0, 5.6], { height: 3.1, spread: 2.6, bark: '#5f4a3a', leaves: ['#6fab55', '#84b95f', '#5f9a4a'], lobes: 4 });
    bush(b, [-5.4, 0, 2.6], 0.5, GREENS, { colors: ['#ffffff', '#fbe9f0'], count: 12 });
    flowerBed(b, [-2.6, 5.2], [0.9, 0.7], 26, ['#ff8fa3', '#ffffff', '#c9a0ff']);
    flowerBed(b, [4.3, 3.9], [0.7, 0.5], 18, ['#ffd95a', '#ffffff', '#ff8fa3']);
    for (const [x, z, size] of [[-4.4, -4.6, 0.5], [3.9, -4.9, 0.36], [-5.1, 0.9, 0.3]] as const) rock(b, [x, 0, z], size, b.pick(LOT.rocks), 0.7);
    site.keep(0, 0.2, 0.6);
  }
  dressShore(b, site, LOT, landing(shape, BRIDGE_WAY.stones), { ...(kind === 'home' ? {} : LIGHT_SHORE), reedless: landing(shape, BRIDGE_WAY.reeds) });
  return b.finish();
}
