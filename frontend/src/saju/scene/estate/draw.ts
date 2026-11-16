import type { Material } from 'three';

import { MOTIFS } from '../../motifs';
import type { Season, TreeState } from '../../mulsang';
import { bench, boat, clothesline, fence, jar, jetty, lantern, pot, stoneWall, well, woodpile } from '../arch';
import { Builder, type Build, type Finish, type V3 } from '../build';
import { buildHome, HOUSE } from '../homes';
import { WATER_LEVEL } from '../mood';
import { bamboo, birch, bush, conifer, crown, flowerBed, lilies, pine, reeds, rock, steppingStones, toned, tree, willow, type Palette } from '../plants';
import { surfaceMaps } from '../surfaces';
import { dressPond } from '../terrain';
import { emblem, keepsake } from '../yard';
import { estateGround, type GroundPaint } from './ground';
import type { Estate, FruitKind, Placement, Species } from './layout';
import { pointAlong, type V2 } from './lines';
import { EstateSite } from './site';

// The estate drawn: its ground and shore, its paths and water, and each pillar's part of it, every one by a Builder of
// its own so that each comes out the same whether it is built alone or with the rest, and the canvas can build them one
// a frame. The house is the houses builder's and the motifs the motifs' builder's: until they are handed in, today's
// house without its island stands in for the one, and plain stand-ins (drawn here, of the shared helpers) for the other.

export type EstatePartKey = 'ground' | 'paths' | 'water' | 'year' | 'month' | 'day' | 'hour' | 'house';

/** A part of the estate to build: where it is mounted about the island's middle, and how it is made. A strip of the ground after the first is keyed `ground:1`, `ground:2` … */
export type EstatePart = { key: EstatePartKey | `ground:${number}`; at: V3; make: () => Build };

export type DrawOptions = {
  /** Every leaf and flower (a laptop), or thinned as a phone's gardens are (homes' THIN). */
  lush?: boolean;
  /** The house, about its own foot (the houses builder's); today's house stands in for it. */
  house?: () => Build;
  /** Draws a motif about its foot into `b`; returns false to leave it to the stand-in. The motifs' builder's. */
  motif?: (b: Builder, placement: Placement, estate: Estate) => boolean;
  /** The ground's colours (the lawn builder's); the season's by default. */
  paint?: GroundPaint;
  /**
   * Into how many strips, north to south, the ground is cut, each a part built on its own: the ground is the costliest
   * part (some 35 ms), and in four strips no frame of the build takes more than about a quarter of it. One by default.
   */
  groundStrips?: number;
};

const TAU = Math.PI * 2;
const QUARTER = Math.PI / 2;
/** How thickly a garden is planted for a device that would labour over a full one, as the homes are. */
const THIN = 0.62;
const WOOD: Finish = { surface: 'wood', rough: 0.8 };
const STONE: Finish = { surface: 'stone', rough: 0.88 };
const GREENS: Palette = ['#3f7a3c', '#4d8a45', '#366b36', '#5b9650'];
const FIRS: Palette = ['#2f5f3f', '#3a6f48', '#285238', '#467d52'];
const PINES: Palette = ['#3f6b4a', '#4a7a55', '#335c40', '#5a8a62'];
const FERNS: Palette = ['#4f8a45', '#5f9a50', '#447a3e'];
const ROCKS: Palette = ['#8f8b7e', '#9c978a', '#7f7b70', '#a8a294'];

/** Each part's seed, from the estate's: a part grows the same whatever the others hold. */
const SALT: Record<EstatePartKey, number> = { ground: 1, paths: 2, water: 3, year: 4, month: 5, day: 6, hour: 7, house: 8 };

/** The ground's colours for an estate in its month's season (mulsang's season), the yard and paths of its house's earth. */
export function seasonPaint(estate: Estate): GroundPaint {
  const { season } = estate.plan;
  const grass = season.grass;
  return {
    lawn: [grass[0]!, grass[1] ?? grass[0]!, grass[3] ?? grass[2] ?? grass[0]!],
    dirt: '#7d634a',
    yard: estate.profile.house.style === 'metal' ? '#d3cfc4' : '#c4ab84',
    path: '#b59c78',
    stones: '#a49a88',
    bank: '#9a907e',
    sand: '#dcc79c',
    bed: '#1c3140',
    cover: season.cover === 'snow' ? 0.6 : season.cover === 'frost' ? 0.12 : 0,
  };
}

/** What a deciduous tree wears in the season, and how full its crown is. */
function leavesOf(species: Species, season: Season): { leaves: Palette; density: number } {
  const full = Math.max(0.32, season.foliage);
  switch (species) {
    case 'fir':
    case 'cypress':
      return { leaves: FIRS, density: 1 };
    case 'pine':
      return { leaves: PINES, density: 1 };
    case 'bamboo':
      return { leaves: ['#8fb35a', '#a3c268', '#7ba04e'], density: 1 };
    case 'maple':
      return { leaves: season.key === 'autumn' ? ['#c8452c', '#d95a2f', '#e08a2e', '#b3381f'] : season.leaves, density: full };
    case 'ginkgo':
      return { leaves: season.key === 'autumn' ? ['#f2c94c', '#e8b83a', '#f6d870'] : season.leaves, density: full };
    case 'birch':
      return { leaves: season.key === 'autumn' ? ['#e0c050', '#d8b040', '#c9a040'] : season.key === 'winter' ? season.leaves : ['#9fc25a', '#b3cf68', '#8ab04d'], density: full };
    case 'willow':
      return { leaves: season.key === 'winter' ? season.leaves : season.key === 'autumn' ? ['#c9c060', '#b8b050', '#d8cf78'] : ['#8fbf5a', '#a3cc68', '#7cae4c', '#b5d67a'], density: full };
    default:
      return { leaves: season.leaves, density: full };
  }
}

/**
 * A fir as plants.conifer draws it, its boughs as many as the Builder's density allows and as much larger: the same
 * cone of needles from afar for a fraction of the sprays.
 */
function leanConifer(b: Builder, at: V3, look: { height: number; radius: number; needles: Palette; tiers?: number }): void {
  const { height, radius, needles, tiers = 6 } = look;
  const thin = Math.min(1, b.density);
  b.group(at, () => {
    const girth = height * 0.03;
    b.limb([[0, -0.15, 0], [0, height * 0.5, 0], [0, height * 0.98, 0]], [girth * 1.7, girth * 0.8, girth * 0.12], '#5f4332', { surface: 'bark', rough: 0.95 });
    const foot = height * 0.16;
    b.cone(radius * 0.72, height - foot, [0, foot + (height - foot) / 2, 0], toned(needles[0]!, 0.4), { rough: 1, sides: 10 });
    const count = Math.round(radius * height * 150 * thin);
    const grow = 1 / Math.sqrt(thin);
    for (let index = 0; index < count; index++) {
      const up = 1 - Math.sqrt(1 - b.random() * 0.98);
      const tier = (up * tiers) % 1;
      const ring = radius * (1 - up) * (1.12 - tier * 0.4) * b.between(0.72, 1.02) + 0.04;
      const angle = b.between(0, TAU);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const shade = (0.66 + (1 - tier) * 0.34) * b.between(0.88, 1.08);
      const lean = Math.hypot(cos, -0.2 + up * 0.9, sin);
      const outLength = Math.hypot(cos, 0.5, sin);
      b.sprig('needle', [cos * ring, foot + (height - foot) * up, sin * ring], b.between(0.3, 0.44) * grow, b.pick(needles), [cos / lean, (-0.2 + up * 0.9) / lean, sin / lean], b.between(0, TAU), [cos / outLength, 0.5 / outLength, sin / outLength], shade);
    }
  });
}

/**
 * A tree of its species in the season. `thin` below 1 draws its crown with fewer, larger sprays that cover it about as
 * fully: for a wood seen mostly from afar, at a fraction of the leaves.
 */
function plantTree(b: Builder, at: V3, spec: { species: Species; height: number; spread: number }, season: Season, thin = 1): void {
  const { leaves, density } = leavesOf(spec.species, season);
  const { species, height, spread } = spec;
  const before = b.density;
  b.density = before * thin;
  if (species === 'fir') leanConifer(b, at, { height, radius: spread / 2, needles: leaves });
  else if (species === 'cypress') leanConifer(b, at, { height, radius: spread / 2, needles: leaves, tiers: 8 });
  else if (species === 'pine') pine(b, at, { height, spread, needles: leaves });
  else if (species === 'birch') birch(b, at, { height, leaves });
  else if (species === 'willow') willow(b, at, { height, spread, leaves });
  else if (species === 'bamboo') bamboo(b, at, { canes: 11, height, reach: spread / 2 });
  else tree(b, at, { height, spread, bark: species === 'persimmon' ? '#4f4036' : '#5a4636', leaves, lobes: 5, density, leaf: 0.27 / Math.sqrt(thin), ...(species === 'persimmon' && season.key === 'autumn' ? { fruit: '#f08a2a' } : {}) });
  b.density = before;
}

/** A fruit tree's colours: its blossom, its fruit, and leaves of its own when it keeps them all year. */
const FRUIT: Record<FruitKind, { blossom: Palette; fruit: string; leaves?: Palette }> = {
  camellia: { blossom: ['#c8283a', '#d93a4a', '#e8566a'], fruit: '#c8283a', leaves: ['#2f5f3a', '#3a6b42', '#285034', '#467a4c'] },
  plum: { blossom: ['#ffffff', '#fbe3ea', '#f7c6d4'], fruit: '#c9d45a' },
  cherry: { blossom: ['#f9c4d4', '#ffe9f0', '#f7a8c4'], fruit: '#b01f33' },
  peach: { blossom: ['#f48fb1', '#f7a8c4', '#ffb7c5'], fruit: '#ffb38a' },
  nankingCherry: { blossom: ['#fff4f2', '#ffe9f0', '#fbe3ea'], fruit: '#d93a4a' },
  apricot: { blossom: ['#fbd0de', '#ffe9f0', '#f9c4d4'], fruit: '#f2a03a' },
  grape: { blossom: ['#c9d48a'], fruit: '#5a3a7a' },
  persimmon: { blossom: ['#f3e3a0'], fruit: '#f08a2a' },
  citron: { blossom: ['#ffffff'], fruit: '#f2c94c', leaves: ['#3f7a3c', '#4d8a45', '#366b36'] },
  mulberry: { blossom: ['#d8e0a0'], fruit: '#3a1f3a' },
  pomegranate: { blossom: ['#e8452f', '#f26a3a', '#ff8a4a'], fruit: '#c22a22', leaves: ['#4f8a3c', '#5f9a48', '#447a34'] },
};

/** A small fruit tree in its own state: bare but for buds, in blossom, or hung with fruit; a grape on its frame of poles. */
function fruitTree(b: Builder, at: V3, kind: FruitKind, state: TreeState | undefined, season: Season, scale: number): void {
  const look = FRUIT[kind];
  const height = 3.2 * scale;
  if (kind === 'grape') {
    b.group(at, () => {
      for (const [x, z] of [[-0.9, -0.7], [0.9, -0.7], [-0.9, 0.7], [0.9, 0.7]] as const) b.cyl(0.05, 1.9, [x, 0.95, z], '#7a5a42', { sides: 7, surface: 'bark' });
      for (const z of [-0.7, 0, 0.7]) b.box([2.0, 0.05, 0.05], [0, 1.9, z], '#8a6648', WOOD);
      crown(b, [0, 2.0, 0], [1.1, 0.22, 0.9], 'leaf', ['#5f9a48', '#6fab55', '#4f8a3c'], Math.round(170 * b.density), 0.28, -0.6);
      if (state === 'fruit') for (let bunch = 0; bunch < 14; bunch++) b.sprig('puff', [b.between(-0.85, 0.85), 1.72, b.between(-0.65, 0.65)], [0.13, 0.22, 0.13], toned(look.fruit, b.between(0.85, 1.15)));
    });
    return;
  }
  const leaves = look.leaves ?? (state === 'blossom' && season.key !== 'summer' ? ['#b5d67a', '#c6e08c', '#a3cc68'] : season.leaves);
  const bare = state === 'bud' || (state === 'blossom' && !look.leaves);
  tree(b, at, {
    height,
    spread: 2.7 * scale,
    bark: '#5a4636',
    leaves,
    lobes: 4,
    flat: 0.72,
    leaf: 0.24,
    density: bare ? 0.35 : Math.max(0.5, season.foliage),
    ...(state === 'blossom' ? { blooms: { colors: look.blossom, share: 0.85, size: 0.18 } } : {}),
    ...(state === 'bud' ? { blooms: { colors: look.blossom, share: 0.5, size: 0.07 } } : {}),
    ...(state === 'fruit' || state === undefined ? { fruit: look.fruit } : {}),
  });
  // What has fallen under it: petals in blossom, a fruit or two when it is hung with them.
  for (let fallen = 0; fallen < (state === 'blossom' ? 22 : 4); fallen++) {
    const angle = b.between(0, TAU);
    const away = Math.sqrt(b.random()) * 1.4 * scale;
    const x = at[0] + Math.cos(angle) * away;
    const z = at[2] + Math.sin(angle) * away;
    if (state === 'blossom') b.sprig('pad', [x, 0.02, z], b.between(0.05, 0.08), b.pick(look.blossom), [0, 1, 0], b.between(0, TAU));
    else b.sprig('puff', [x, 0.07, z], 0.14, look.fruit);
  }
}

function fern(b: Builder, x: number, z: number, size = 0.46): void {
  for (let blade = 0; blade < 7; blade++) {
    const turn = (blade / 7) * TAU + b.between(-0.2, 0.2);
    b.sprig('frond', [x, 0.02, z], size * b.between(0.8, 1.15), b.pick(FERNS), [Math.cos(turn) * 0.75, 0.6, Math.sin(turn) * 0.75], b.between(0, TAU), [0, 1, 0], b.between(0.8, 1.05));
  }
}

function mushroom(b: Builder, x: number, z: number, scale: number, cap: string): void {
  b.cyl(0.03 * scale, 0.1 * scale, [x, 0.05 * scale, z], '#f3ead8', { sides: 7, rough: 0.9 });
  b.dome([0.09 * scale, 0.07 * scale, 0.09 * scale], [x, 0.09 * scale, z], cap, { detail: 10, rough: 0.6 });
}

/** A low fence about a box on the ground, left open wherever `open` says (a path comes through). */
function fenceAbout(b: Builder, box: { minX: number; maxX: number; minZ: number; maxZ: number }, open: (x: number, z: number) => boolean, look: Parameters<typeof fence>[3]): void {
  const corners: V2[] = [[box.minX, box.minZ], [box.maxX, box.minZ], [box.maxX, box.maxZ], [box.minX, box.maxZ]];
  for (let side = 0; side < 4; side++) {
    const from = corners[side]!;
    const to = corners[(side + 1) % 4]!;
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const steps = Math.max(1, Math.round(length / 0.5));
    let run: V2 | null = null;
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const point: V2 = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      const gap = open(point[0], point[1]);
      if (!gap && !run) run = point;
      if ((gap || step === steps) && run) {
        const end: V2 = gap ? [from[0] + (to[0] - from[0]) * ((step - 1) / steps), from[1] + (to[1] - from[1]) * ((step - 1) / steps)] : point;
        if (Math.hypot(end[0] - run[0], end[1] - run[1]) > 0.9) fence(b, run, end, look);
        run = null;
      }
    }
  }
}

/** A flower bed of the month stem's kind, about 2.2 by 2 metres, in the season's flowers. */
function flowerBedOf(b: Builder, placement: Placement, season: Season): void {
  const [x, z] = placement.at;
  const blooms = season.blooms;
  // A bed's size follows the room the layout gave it; the flowers are as thick in a small one as in a large one.
  const grow = placement.scale;
  const reach: [number, number] = [1.05 * grow, 0.95 * grow];
  const many = (count: number) => Math.round(count * grow * grow * 1.8);
  switch (placement.bed) {
    case 'hedge':
      flowerBed(b, [x, z], [0.8 * grow, 0.7 * grow], many(34), blooms, { size: 0.12 });
      for (let index = 0; index < 18; index++) {
        const angle = (index / 18) * TAU;
        bush(b, [x + Math.cos(angle) * 1.1 * grow, 0, z + Math.sin(angle) * 0.98 * grow], 0.2, GREENS, undefined, 0.9);
      }
      break;
    case 'tall':
      flowerBed(b, [x, z], reach, many(40), blooms, { height: [0.45, 0.8], size: 0.15 });
      break;
    case 'lanterns':
      flowerBed(b, [x, z], reach, many(36), blooms, { size: 0.12 });
      for (const side of [-1, 1]) lantern(b, [x + side * 0.75 * grow, 0, z + side * 0.5 * grow], { kind: 'path', height: 0.3 });
      break;
    case 'rocks':
      for (let stone = 0; stone < 5; stone++) rock(b, [x + b.between(-0.8, 0.8), 0, z + b.between(-0.7, 0.7)], b.between(0.3, 0.55), b.pick(ROCKS), 0.6);
      flowerBed(b, [x, z], reach, many(22), blooms, { height: [0.1, 0.22], size: 0.1 });
      break;
    case 'rows':
      for (const dz of [-0.6, 0, 0.6]) flowerBed(b, [x, z + dz * grow], [1.0 * grow, 0.16], many(12), blooms, { height: [0.14, 0.28], size: 0.12 });
      break;
    case 'edged':
      for (let index = 0; index < 22; index++) {
        const angle = (index / 22) * TAU;
        rock(b, [x + Math.cos(angle) * 1.1 * grow, 0, z + Math.sin(angle) * 0.98 * grow], 0.2, b.pick(['#c9c2b4', '#b7ad9d']), 0.5);
      }
      flowerBed(b, [x, z], [0.9 * grow, 0.8 * grow], many(34), blooms, { size: 0.12 });
      break;
    case 'gravel':
      b.cyl(1.05, 0.03, [x, 0.012, z], '#e4e1d8', { sides: 32, surface: 'gravel', rough: 0.95, shadowless: true });
      for (let stone = 0; stone < 3; stone++) rock(b, [x + b.between(-0.6, 0.6), 0, z + b.between(-0.5, 0.5)], b.between(0.25, 0.42), b.pick(ROCKS), 0.7);
      flowerBed(b, [x, z], [0.85 * grow, 0.75 * grow], many(14), blooms, { height: [0.12, 0.26], size: 0.11 });
      break;
    case 'water':
      b.cyl(0.62, 0.02, [x, 0.012, z], '#2a4563', { rough: 0.05, metal: 0.9, sides: 26 });
      for (let index = 0; index < 16; index++) {
        const angle = (index / 16) * TAU + b.between(-0.1, 0.1);
        rock(b, [x + Math.cos(angle) * 0.72, 0, z + Math.sin(angle) * 0.66], 0.18, b.pick(ROCKS), 0.55);
      }
      flowerBed(b, [x, z], [1.05, 0.95], 18, ['#7a5fd0', '#9a7fe8', '#5f4fb8'], { height: [0.32, 0.5], keep: (px, pz) => Math.hypot((px - x) / 0.9, (pz - z) / 0.84) > 1 });
      break;
    case 'moss':
      for (let mound = 0; mound < 9; mound++) b.sprig('puff', [x + b.between(-0.8, 0.8), 0.04, z + b.between(-0.7, 0.7)], [b.between(0.35, 0.6), 0.16, b.between(0.35, 0.6)], b.pick(['#5f8a3c', '#6f9a45', '#4f7a34']));
      for (let stone = 0; stone < 3; stone++) rock(b, [x + b.between(-0.6, 0.6), 0, z + b.between(-0.5, 0.5)], b.between(0.3, 0.45), b.pick(ROCKS), 0.6);
      break;
    default:
      flowerBed(b, [x, z], reach, many(46), blooms, { size: 0.12 });
  }
}

/**
 * A motif drawn plainly about its foot, of the shared helpers: what stands until the motifs' builder draws it. Each
 * is about the size the catalogue gives it (motifs.ts), facing +z before it is turned to its placement's facing.
 */
function motifStandIn(b: Builder, placement: Placement, estate: Estate): void {
  const { season } = estate.plan;
  const [x, z] = placement.at;
  const at: V3 = [x, 0, z];
  const tone = placement.part ? (estate.plan.colors[placement.part] ?? estate.plan.colors.house) : estate.plan.colors.house;
  const along = placement.along;
  switch (placement.motif) {
    case 'forestEdge': {
      const line = along ?? [[x - 3, z], [x + 3, z]];
      for (let index = 0; index < 6; index++) {
        const { at: spot } = pointAlong(line, (index + 0.5) / 6);
        const species: Species = (['fir', 'zelkova', 'birch'] as const)[index % 3]!;
        plantTree(b, [spot[0] + b.between(-0.4, 0.4), 0, spot[1] + b.between(-0.4, 0.4)], { species, height: b.between(4.6, 6.2), spread: species === 'fir' ? 2.6 : 3.4 }, season);
        fern(b, spot[0] + 1.2, spot[1] + 1.4);
      }
      return;
    }
    case 'stoneWall':
    case 'earthWall': {
      const line = along ?? [[x - 2, z], [x + 2, z]];
      const cap = estate.profile.house.style === 'metal' ? '#4f5661' : '#7a6652';
      for (let index = 1; index < line.length; index++) {
        const from = line[index - 1]!;
        const to = line[index]!;
        if (placement.motif === 'stoneWall') stoneWall(b, from, to, 0.55, ['#b7ad9d', '#a39988', '#c7bdac', '#958b7b'], cap);
        else {
          const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
          const turn = Math.atan2(-(to[1] - from[1]), to[0] - from[0]);
          b.box([length + 0.02, 0.7, 0.34], [(from[0] + to[0]) / 2, 0.35, (from[1] + to[1]) / 2], '#d2a66c', { surface: 'plaster', rough: 0.95 }, turn);
          b.prism([length + 0.1, 0.16, 0.5], [(from[0] + to[0]) / 2, 0.7, (from[1] + to[1]) / 2], '#5a4a3e', { surface: 'clay', rough: 0.8 }, turn);
        }
      }
      return;
    }
    case 'oldTree':
      tree(b, at, { height: 6.4, spread: 4.6, bark: '#5a4636', leaves: leavesOf('zelkova', season).leaves, lobes: 6, girth: 0.34, lean: 0.05, fork: 0.4, density: leavesOf('zelkova', season).density });
      b.group(at, () => {
        b.ring(0.42, 0.04, [0, 1.3, 0], '#d9c08a', { surface: 'thatch', rough: 1 }, [QUARTER, 0, 0]);
        for (let strip = 0; strip < 8; strip++) b.box([0.06, 0.22, 0.01], [Math.cos((strip / 8) * TAU) * 0.44, 1.16, Math.sin((strip / 8) * TAU) * 0.44], '#f6f2ea', { rough: 0.9 }, -(strip / 8) * TAU + QUARTER);
        for (let seat = 0; seat < 9; seat++) b.cyl(0.24, 0.16, [Math.cos((seat / 9) * TAU) * 1.2, 0.08, Math.sin((seat / 9) * TAU) * 1.2], '#c9c2b4', { ...STONE, sides: 10 });
      });
      return;
    case 'birches':
      for (let index = 0; index < 4; index++) birch(b, [x + b.between(-1, 1), 0, z + b.between(-1, 1)], { height: b.between(3.6, 5), leaves: leavesOf('birch', season).leaves });
      return;
    case 'pines':
      pine(b, [x - 0.4, 0, z], { height: 3.8, spread: 2.8, needles: PINES });
      conifer(b, [x + 1, 0, z + 0.3], { height: 3.4, radius: 0.55, needles: FIRS, tiers: 8 });
      for (let stone = 0; stone < 3; stone++) rock(b, [x + b.between(-1, 1), 0, z + b.between(0.4, 1)], b.between(0.3, 0.5), b.pick(ROCKS));
      return;
    case 'willow':
      plantTree(b, at, { species: 'willow', height: 4.2, spread: 3.6 }, season);
      return;
    case 'ginkgo':
      plantTree(b, at, { species: 'ginkgo', height: 5.6, spread: 3.2 }, season);
      for (let leaf = 0; leaf < 40; leaf++) b.sprig('pad', [x + b.between(-1.6, 1.6), 0.02, z + b.between(-1.6, 1.6)], 0.07, b.pick(['#f2c94c', '#e8b83a']), [0, 1, 0], b.between(0, TAU));
      return;
    case 'mulberry':
      tree(b, at, { height: 3.4, spread: 3.2, bark: '#5a4a3e', leaves: season.leaves, lobes: 5, flat: 0.6, fruit: '#3a1f3a', density: Math.max(0.4, season.foliage) });
      return;
    case 'pomegranate':
      fruitTree(b, at, 'pomegranate', placement.state ?? (season.key === 'summer' ? 'blossom' : 'fruit'), season, 1.05);
      return;
    case 'saplings':
      for (let index = 0; index < 3; index++) {
        const sx = x + (index - 1) * 1.2;
        tree(b, [sx, 0, z], { height: 2.0, spread: 1.4, bark: '#6b5444', leaves: season.leaves, lobes: 3, density: Math.max(0.4, season.foliage) });
        b.box([0.04, 1.3, 0.04], [sx + 0.12, 0.65, z], '#a98458', WOOD);
        b.ring(0.07, 0.02, [sx + 0.06, 0.9, z], '#d9c08a', { surface: 'thatch' }, [QUARTER, 0, 0]);
      }
      return;
    case 'bamboo':
      bamboo(b, at, { canes: 13, height: 4.2, reach: 0.7 });
      return;
    case 'rockHill':
      b.group(at, () => {
        for (let stone = 0; stone < 7; stone++) rock(b, [b.between(-0.7, 0.7), b.between(0, 0.5), b.between(-0.6, 0.6)], b.between(0.5, 0.9), b.pick(['#8f9299', '#a1a4aa', '#7e8188']), 0.85);
        pine(b, [0.3, 0.6, -0.2], { height: 1.6, spread: 1.2, needles: PINES });
        if (placement.variant === 'lit') lantern(b, [-0.75, 0, 0.75], { kind: 'stone' });
      });
      b.life({ kind: 'mist', at: [x, 1.3, z], reach: 1.2 });
      return;
    case 'standingStones':
      for (const [dx, dz, tall] of [[-0.6, 0, 1.9], [0.4, -0.3, 1.5], [1.0, 0.5, 1.15]] as const) b.sprig('rock', [x + dx, tall * 0.42, z + dz], [0.5, tall, 0.38], b.pick(['#9c978a', '#8f8b7e', '#a8a294']), [0, 1, 0], b.between(0, TAU), [0, 1, 0], 1);
      return;
    case 'pavilion':
      b.group(
        at,
        () => {
          b.box([2.2, 0.3, 2.2], [0, 0.15, 0], '#cfc8bb', STONE);
          b.box([2.0, 0.06, 2.0], [0, 0.33, 0], '#9a7350', { ...WOOD, vary: 0.05 });
          for (const [px, pz] of [[-0.9, -0.9], [0.9, -0.9], [0.9, 0.9], [-0.9, 0.9]] as const) b.cyl(0.07, 1.7, [px, 1.2, pz], '#7a3a2a', { sides: 10, surface: 'wood' });
          b.prism([2.9, 0.9, 2.9], [0, 2.05, 0], '#5a6370', { surface: 'clay', rough: 0.7, ridge: 0.3 });
          b.box([2.2, 0.14, 2.2], [0, 2.0, 0], '#6b3a2a', WOOD);
          for (const side of [-1, 1]) b.box([1.8, 0.05, 0.05], [0, 0.65, side * 0.9], '#7a3a2a', WOOD);
        },
        placement.facing,
      );
      return;
    case 'beacon':
      b.group(at, () => {
        for (let course = 0; course < 6; course++) b.cyl(0.62 - course * 0.05, 0.24, [0, 0.12 + course * 0.24, 0], b.pick(['#a39988', '#b7ad9d', '#958b7b']), { ...STONE, sides: 14, top: 0.6 - course * 0.05 });
        b.cyl(0.36, 0.06, [0, 1.5, 0], '#3a3331', { sides: 12 });
        b.life({ kind: 'fire', at: [0, 1.56, 0], scale: 0.8 });
        b.life({ kind: 'smoke', at: [0, 2.1, 0], scale: 0.7 });
        b.lamp([0, 1.9, 0], '#ff9a4a', 2.4, 5, true);
      });
      return;
    case 'kiln':
      b.group(
        at,
        () => {
          for (let hump = 0; hump < 4; hump++) b.dome([0.62, 0.55 - hump * 0.04, 0.66], [0, hump * 0.18, -hump * 0.7], '#a8784a', { surface: 'plaster', rough: 0.95 });
          b.cyl(0.18, 0.7, [0, 0.9, -2.5], '#8a5f3d', { surface: 'brick', sides: 10 });
          b.box([0.36, 0.3, 0.1], [0, 0.15, 0.62], '#ff8a3d', { glow: '#ff6a1e', power: 3 });
          b.life({ kind: 'fire', at: [0, 0.18, 0.64], scale: 0.5 });
          b.life({ kind: 'smoke', at: [0, 1.3, -2.5], scale: 0.7 });
          b.lamp([0, 0.4, 0.9], '#ff9050', 1.6, 3.5, true);
          jar(b, [0.95, 0, 0.3], 0.9, '#6b4a35');
          jar(b, [1.2, 0, -0.35], 0.7, '#5b3d2c');
        },
        placement.facing,
      );
      return;
    case 'waterwheel':
      b.group(at, () => {
        b.box([1.2, 0.9, 1.0], [0, 0.45, 0], '#8a6648', WOOD);
        b.prism([1.5, 0.5, 1.3], [0, 0.9, 0], '#d2b060', { surface: 'thatch', rough: 1 });
        b.ring(0.62, 0.05, [0.75, 0.62, 0], '#6b4a35', WOOD, QUARTER);
        for (let paddle = 0; paddle < 8; paddle++) {
          const angle = (paddle / 8) * TAU;
          b.box([0.22, 0.14, 0.04], [0.75, 0.62 + Math.sin(angle) * 0.55, Math.cos(angle) * 0.55], '#7a5a42', WOOD, [angle, QUARTER, 0]);
        }
      });
      return;
    case 'well':
      well(b, at, { cover: { kind: 'barrel', tiles: ['#4f5661', '#59606b', '#474d57'], pan: '#30343b' } }, placement.facing);
      return;
    case 'brook': {
      const line = along ?? estate.stream.line;
      for (const share of [0.3, 0.55]) {
        const { at: spot, heading } = pointAlong(line, share);
        for (let stone = -1; stone <= 1; stone++) rock(b, [spot[0] - Math.sin(heading) * stone * 0.45, WATER_LEVEL + 0.12, spot[1] + Math.cos(heading) * stone * 0.45], 0.32, '#a39988', 0.35);
      }
      return;
    }
    case 'spring':
      keepsake(b, 'water', at);
      return;
    case 'rainCloud':
      b.group([x, 0, z], () => {
        for (let puff = 0; puff < 9; puff++) b.sprig('puff', [b.between(-0.7, 0.7), 2.5 + b.between(-0.15, 0.2), b.between(-0.45, 0.45)], b.between(0.45, 0.7), placement.variant === 'storm' ? '#c9ccd6' : '#f6f8fb');
        for (let drop = 0; drop < 16; drop++) b.box([0.008, 0.2, 0.008], [b.between(-0.6, 0.6), b.between(0.6, 2.1), b.between(-0.4, 0.4)], '#bcd2ea', { opacity: 0.6, shadowless: true });
      });
      return;
    case 'pearlShell':
      b.group(
        at,
        () => {
          b.dome([0.45, 0.16, 0.42], [0, 0.02, 0], '#f2d6d6', { rough: 0.3 });
          b.dome([0.45, 0.16, 0.42], [0, 0.06, -0.38], '#f6e3e3', { rough: 0.3 }, [-1.1, 0, 0]);
          for (let pearl = 0; pearl < 4; pearl++) b.ball(0.06, [b.between(-0.18, 0.18), 0.12, b.between(-0.12, 0.12)], '#fff7f2', { glow: '#fff0e0', power: 0.6, rough: 0.2, detail: 10 });
        },
        placement.facing,
      );
      return;
    case 'goldSand':
      for (let fleck = 0; fleck < 36; fleck++) b.sprig('pebble', [x + b.between(-1.6, 1.6), 0.0, z + b.between(-1, 1)], b.between(0.06, 0.14), b.pick(['#e8c25a', '#f2d070', '#d8b048']), [0, 1, 0], b.between(0, TAU));
      return;
    case 'sandbank':
      for (let shell = 0; shell < 22; shell++) b.sprig(shell % 3 ? 'pad' : 'puff', [x + b.between(-1.6, 1.6), 0.02, z + b.between(-1.1, 1.1)], b.between(0.06, 0.11), b.pick(['#f6d8d8', '#fbe9dc', '#f2e6cc', '#f7c6c0']), [0, 1, 0], b.between(0, TAU));
      b.limb([[x - 0.8, 0.06, z + 0.4], [x - 0.1, 0.09, z + 0.2], [x + 0.6, 0.05, z - 0.1]], [0.07, 0.06, 0.04], '#c9b8a0', { sides: 7, surface: 'wood' });
      return;
    case 'crystals':
      b.group(at, () => {
        rock(b, [0, 0, 0], 0.7, '#4f4a5a', 0.6);
        for (let shard = 0; shard < 6; shard++) {
          const angle = (shard / 6) * TAU;
          b.cone(0.07, b.between(0.35, 0.7), [Math.cos(angle) * 0.18, 0.4, Math.sin(angle) * 0.18], shard % 2 ? '#d9c8ff' : '#f2f2ff', { glow: '#c9b8ff', power: 0.5, sides: 6, rough: 0.15 }, [Math.sin(angle) * 0.4, 0, -Math.cos(angle) * 0.4]);
        }
      });
      return;
    case 'boat':
      boat(b, [x, WATER_LEVEL, z], placement.facing + QUARTER, '#6b4a35');
      b.life({ kind: 'ripples', at: [x, WATER_LEVEL, z], reach: 0.9 });
      return;
    case 'hearth':
      b.group(at, () => {
        b.cyl(0.55, 0.5, [0, 0.25, 0], '#9a7a52', { surface: 'plaster', sides: 14, top: 0.5 });
        b.ball(0.36, [0, 0.62, 0], '#2b2829', { scale: [1, 0.62, 1], metal: 0.6, rough: 0.5, detail: 14 });
        b.cyl(0.34, 0.05, [0, 0.82, 0], '#8a6648', { ...WOOD, sides: 14 });
        b.life({ kind: 'fire', at: [0, 0.16, 0.5], scale: 0.4 });
        b.life({ kind: 'smoke', at: [0, 0.9, 0], scale: 0.5 });
        b.lamp([0, 0.3, 0.7], '#ff9050', 1.4, 3, true);
      });
      return;
    case 'bonfire':
      b.group(at, () => {
        b.cyl(1.3, 0.04, [0, 0.012, 0], '#cdbfa8', { sides: 36, surface: 'gravel', rough: 0.95, shadowless: true });
        for (let stone = 0; stone < 11; stone++) rock(b, [Math.cos((stone / 11) * TAU) * 0.42, 0.02, Math.sin((stone / 11) * TAU) * 0.42], 0.22, b.pick(['#8f867c', '#a0968a']), 0.75);
        for (const turn of [0, 2.1, 4.2]) b.cyl(0.045, 0.56, [Math.cos(turn) * 0.12, 0.25, Math.sin(turn) * 0.12], '#3d2c22', { sides: 7, surface: 'bark' }, [Math.sin(turn) * 0.55, 0, -Math.cos(turn) * 0.55]);
        for (const [sx, sz] of [[-1.0, 0.6], [0.95, 0.85], [0, -1.05]] as const) b.cyl(0.17, 0.24, [sx, 0.12, sz], '#8b6444', { sides: 12, surface: 'bark' });
        b.life({ kind: 'fire', at: [0, 0.12, 0] });
        b.lamp([0, 0.6, 0], '#ff9a4a', 3.4, 6, true);
      });
      return;
    case 'jars':
      b.group(at, () => {
        b.box([2.2, 0.2, 1.6], [0, 0.1, 0], '#d8d0c0', { surface: 'masonry', rough: 0.9 });
        for (const [jx, jz, scale, color] of [[-0.6, -0.35, 1.4, '#5b3d2c'], [0.1, -0.4, 1.2, '#6b4a35'], [0.7, -0.2, 1.0, '#4f3527'], [-0.4, 0.4, 0.9, '#6b4a35'], [0.3, 0.45, 0.75, '#5b3d2c'], [0.8, 0.42, 0.6, '#4f3527']] as const) jar(b, [jx, 0.2, jz], scale, color);
      });
      return;
    case 'vegetableRows':
      for (const [row, dz] of [-0.6, 0, 0.6].entries()) {
        b.box([2.2, 0.13, 0.38], [x, 0.045, z + dz], '#5f4330', { surface: 'soil', rough: 1 });
        for (let plant = 0; plant < 7; plant++) {
          const px = x - 0.95 + plant * 0.32;
          if (row === 1) b.sprig('puff', [px, 0.2, z + dz], [0.22, 0.16, 0.22], '#b5d68a');
          else b.sprig('leaf', [px, 0.22, z + dz], [0.28, 0.36, 0.28], b.pick(GREENS), [0, 1, 0], plant, [0, 1, 0]);
        }
      }
      return;
    case 'sunflowers':
      for (let stalk = 0; stalk < 7; stalk++) {
        const sx = x + (stalk - 3) * 0.32 + b.between(-0.05, 0.05);
        const tall = b.between(1.3, 1.8);
        b.limb([[sx, 0, z], [sx, tall, z]], [0.025, 0.018], '#5f8a3c', { sides: 5 });
        b.sprig('leaf', [sx, tall * 0.55, z], 0.3, '#5f9a48', [0.6, 0.4, 0.3], stalk);
        b.cyl(0.16, 0.05, [sx, tall + 0.05, z + 0.03], '#f2c21f', { sides: 14, rough: 0.8 }, [1.1, 0, 0]);
        b.cyl(0.08, 0.06, [sx, tall + 0.06, z + 0.06], '#5a3a1f', { sides: 10, rough: 0.9 }, [1.1, 0, 0]);
      }
      return;
    case 'irises':
      flowerBed(b, [x, z], [0.9, 0.6], 26, ['#7a5fd0', '#9a7fe8', '#5f4fb8'], { height: [0.3, 0.5], leaves: ['#5f9a50', '#4f8a45'] });
      return;
    case 'forsythia':
      for (let index = 0; index < 6; index++) bush(b, [x + (index - 2.5) * 0.7, 0, z], 0.42, GREENS, season.key === 'spring' ? { colors: ['#ffd23f', '#ffe066', '#f2c21f'], count: 22 } : undefined, 0.85);
      return;
    case 'swing':
      b.group(
        at,
        () => {
          for (const side of [-1, 1]) b.box([0.08, 2.0, 0.08], [side * 0.8, 1.0, 0], '#7a5a42', WOOD);
          b.box([1.8, 0.09, 0.09], [0, 2.0, 0], '#7a5a42', WOOD);
          for (const side of [-1, 1]) b.limb([[side * 0.3, 1.98, 0], [side * 0.3, 0.52, 0.02]], [0.012], '#c9b28a', { sides: 4 });
          b.box([0.7, 0.05, 0.26], [0, 0.5, 0.02], '#9a7350', WOOD);
        },
        placement.facing,
      );
      return;
    case 'clothesline':
      clothesline(b, [x - 1.1, z], [x + 1.1, z - 0.3], ['#ffffff', '#9fc4e8', '#f2b8c6', '#f6d77a', '#c9e4c5']);
      return;
    case 'beehive':
      b.group(at, () => {
        b.box([1.3, 0.12, 0.7], [0, 0.06, 0], '#b7ad9d', STONE);
        for (const hx of [-0.4, 0.05, 0.5]) {
          b.box([0.34, 0.4, 0.34], [hx, 0.32, 0], '#d9b46a', { ...WOOD, vary: 0.08 });
          b.box([0.4, 0.05, 0.4], [hx, 0.54, 0], '#8a6648', WOOD);
        }
      });
      return;
    case 'gate':
      b.group(
        at,
        () => {
          for (const side of [-1, 1]) b.box([0.12, 1.6, 0.12], [side * 0.65, 0.8, 0], '#6b3a2a', WOOD);
          b.prism([1.8, 0.35, 0.7], [0, 1.6, 0], '#4f5661', { surface: 'clay', rough: 0.7 });
          for (const side of [-1, 1]) b.box([0.55, 1.2, 0.04], [side * 0.62, 0.65, side * 0.24], '#8a5a3a', WOOD, side * 1.1);
        },
        placement.facing,
      );
      return;
    case 'bonsai':
      b.group(at, () => {
        b.box([1.1, 0.4, 0.4], [0, 0.2, 0], '#c9c2b4', STONE);
        for (const px of [-0.32, 0.32]) {
          b.cyl(0.14, 0.1, [px, 0.45, 0], '#5a6a78', { rough: 0.4, sides: 12 });
          pine(b, [px, 0.5, 0], { height: 0.45, spread: 0.45, needles: PINES });
        }
      });
      return;
    case 'flowerArch':
      emblem(b, 'trellis', at);
      return;
    case 'stringLights': {
      const color = placement.variant === 'lotus' ? '#ffb3c8' : placement.variant === 'pearls' ? '#fff4ec' : placement.variant === 'silk' ? '#e8566a' : '#ffe7b5';
      const strung = (t: number): V3 => [x - 1.6 + 3.2 * t, 1.9 - Math.sin(t * Math.PI) * 0.3, z];
      for (const t of [0, 1]) b.cyl(0.035, 1.95, [strung(t)[0], 0.975, z], '#4a372b', { sides: 6, surface: 'wood' });
      for (let bulb = 0; bulb < 10; bulb++) {
        const spot = strung((bulb + 0.5) / 10);
        b.ball(placement.variant === 'silk' ? 0.07 : 0.04, [spot[0], spot[1] - 0.04, spot[2]], color, { glow: color, power: 5, detail: 8 });
      }
      b.lamp(strung(0.5), '#ffc27a', 1, 3);
      b.limb(Array.from({ length: 9 }, (_, index) => strung(index / 8)), [0.006], '#2a2423', { sides: 4, shadowless: true });
      return;
    }
    case 'candles':
      for (let candle = 0; candle < 5; candle++) {
        const cx = x + b.between(-0.3, 0.3);
        const cz = z + b.between(-0.25, 0.25);
        const tall = b.between(0.12, 0.26);
        b.cyl(0.035, tall, [cx, tall / 2, cz], '#fbf6ea', { sides: 10, rough: 0.6 });
        b.ball(0.02, [cx, tall + 0.03, cz], '#ffd76a', { glow: '#ffb347', power: 6, detail: 6 });
      }
      b.lamp([x, 0.4, z], '#ffb86a', 1.0, 2.5, true);
      return;
    case 'stoneLamp':
      lantern(b, at, { kind: 'stone' });
      return;
    case 'signpost':
      b.cyl(0.05, 1.5, [x, 0.75, z], '#7a5a42', { sides: 8, surface: 'wood' });
      for (const [y, turn] of [[1.3, 0.4], [1.1, -0.9], [0.9, 2.2]] as const) b.box([0.6, 0.12, 0.03], [x + Math.cos(turn) * 0.2, y, z - Math.sin(turn) * 0.2], '#a98458', WOOD, turn);
      return;
    case 'cart':
      b.group(
        at,
        () => {
          b.box([0.9, 0.3, 0.6], [0, 0.45, 0], '#9a7350', WOOD);
          for (const side of [-1, 1]) b.ring(0.28, 0.03, [0, 0.28, side * 0.34], '#6b4a35', WOOD);
          b.box([0.05, 0.05, 0.9], [0.6, 0.45, 0], '#7a5a42', WOOD, [0, QUARTER, 0]);
          b.ball(0.2, [0.05, 0.68, 0], '#e88a2c', { scale: [1, 0.75, 1], detail: 12 });
        },
        placement.facing,
      );
      return;
    case 'mushrooms':
      for (const [mx, mz, scale, cap] of [[0, 0, 1.3, '#c8402f'], [0.25, 0.2, 0.9, '#c8402f'], [-0.3, 0.15, 1.0, '#b5803a'], [0.1, -0.3, 0.8, '#b5803a']] as const) mushroom(b, x + mx, z + mz, scale, cap);
      fern(b, x - 0.5, z - 0.3, 0.4);
      return;
    case 'butterflies':
      for (let index = 0; index < 3; index++) b.life({ kind: 'butterfly', at: [x + b.between(-2, 2), 0.7, z + b.between(-2, 2)], color: b.pick(['#fff3b0', '#ffb7c5', '#cfe0ff']), phase: index * 2.1 });
      return;
    case 'fireflies':
      b.life({ kind: 'fireflies', at: [x, 0.8, z], reach: 3, count: 14 });
      return;
    case 'chicks':
      for (let chick = 0; chick < 5; chick++) {
        const cx = x + b.between(-1.2, 1.2);
        const cz = z + b.between(-1, 1);
        b.ball(0.08, [cx, 0.08, cz], '#ffd84a', { detail: 10 });
        b.ball(0.05, [cx + 0.06, 0.15, cz], '#ffd84a', { detail: 8 });
      }
      return;
    case 'dragonflies':
      for (let fly = 0; fly < 3; fly++) b.box([0.16, 0.01, 0.03], [x + b.between(-1, 1), 0.9 + b.between(0, 0.3), z + b.between(-1, 1)], '#d6362a', { shadowless: true }, b.between(0, TAU));
      return;
    case 'ducks':
      for (let duck = 0; duck < 4; duck++) {
        const dx = x + duck * 0.45 - 0.6;
        const big = duck === 0 ? 1.4 : 0.8;
        b.ball(0.12 * big, [dx, WATER_LEVEL + 0.04 * big, z + duck * 0.2], duck === 0 ? '#8a6a48' : '#e8d070', { scale: [1.3, 0.7, 0.9], detail: 10 });
        b.ball(0.06 * big, [dx + 0.12 * big, WATER_LEVEL + 0.13 * big, z + duck * 0.2], duck === 0 ? '#2f6b45' : '#e8d070', { detail: 8 });
      }
      return;
    case 'pots':
      pot(b, at, 1, GREENS, season.blooms);
      pot(b, [x + 0.4, 0, z + 0.2], 0.8, GREENS, season.blooms);
      return;
    case 'woodpile':
      woodpile(b, at, placement.facing);
      return;
    case 'pond':
      return; // The pond's hollow is the site's; its stones, lilies and fish are the water part's.
    case 'dirtPath':
      return; // The garden's paths are its own ground.
    default:
      // What has no stand-in yet: a small life is left to its own builder (it moves); anything else is marked by a
      // cairn in the pillar's colour, so the spot it keeps shows.
      if (placement.motif && MOTIFS[placement.motif]?.places.includes('life')) return;
      for (let stone = 0; stone < 3; stone++) rock(b, [x, stone * 0.2, z], 0.42 - stone * 0.1, stone === 2 ? tone.main : b.pick(ROCKS), 0.7);
  }
}

/**
 * How thinly a tree of the estate's own is leaved: the wood along the far shore most (it is seen from afar, and there
 * are many of it), the lone trees and the garden's less, what stands close to the house in full.
 */
function thinOf(placement: Placement): number {
  if (placement.id.startsWith('year:wood')) return 0.36;
  if (placement.id.startsWith('year:')) return 0.5;
  if (placement.id.startsWith('month:')) return 0.75;
  return 1;
}

/** The motif at its foot, by the motifs' builder when it is handed in and draws it, else by its stand-in. */
function drawMotif(b: Builder, placement: Placement, estate: Estate, options: DrawOptions): void {
  if (options.motif?.(b, placement, estate)) return;
  motifStandIn(b, placement, estate);
}

/** Every placement drawn by the estate (or its motifs) in one part, in the order they were laid. */
function drawPlacements(b: Builder, estate: Estate, options: DrawOptions, keep: (placement: Placement) => boolean): void {
  const { season } = estate.plan;
  const lamps: Record<string, 'path' | 'stone' | 'post'> = { wood: 'path', fire: 'post', earth: 'stone', metal: 'stone', water: 'path' };
  for (const placement of estate.placements) {
    if (!keep(placement)) continue;
    const [x, z] = placement.at;
    const at: V3 = [x, 0, z];
    switch (placement.kind) {
      case 'motif':
        if (placement.by !== 'house') drawMotif(b, placement, estate, options);
        break;
      case 'tree':
        if (placement.tree) plantTree(b, at, placement.tree, season, thinOf(placement));
        break;
      case 'fruitTree': {
        const before = b.density;
        b.density = before * 0.7;
        fruitTree(b, at, placement.fruit ?? 'plum', placement.state, season, placement.scale);
        b.density = before;
        break;
      }
      case 'bush':
        bush(b, at, placement.scale, GREENS, season.key === 'spring' || season.key === 'summer' ? { colors: season.blooms, count: Math.round(placement.scale * 26) } : undefined);
        break;
      case 'bed':
        flowerBedOf(b, placement, season);
        break;
      case 'wildflowers': {
        // Their leaves are the lawn's own greens, so only the flowers stand out of the grass.
        const radius = placement.scale;
        flowerBed(b, [x, z], [radius, radius * 0.8], Math.round(radius * radius * 9), season.blooms, { height: [0.1, 0.24], size: 0.1, leaves: season.grass });
        break;
      }
      case 'meadow': {
        // Open grass for the pets, drifts of flowers about its edge where they do not run, a few more scattered in it.
        const { rx, rz } = estate.meadow;
        for (let drift = 0; drift < 7; drift++) {
          const angle = (drift / 7) * TAU + b.between(-0.3, 0.3);
          const away = b.between(0.82, 1.0);
          const size = b.between(0.7, 1.2);
          flowerBed(b, [x + Math.cos(angle) * rx * away, z + Math.sin(angle) * rz * away], [size, size * 0.7], Math.round(size * size * 16), season.blooms, { height: [0.1, 0.26], size: 0.11, leaves: season.grass });
        }
        flowerBed(b, [x, z], [rx * 0.7, rz * 0.7], 26, season.blooms, { height: [0.08, 0.18], size: 0.09, leaves: season.grass });
        break;
      }
      case 'rocks':
        for (let stone = 0; stone < 3; stone++) rock(b, [x + b.between(-0.5, 0.5) * placement.scale, 0, z + b.between(-0.5, 0.5) * placement.scale], b.between(0.25, 0.6) * placement.scale, b.pick(ROCKS), 0.7);
        break;
      case 'ferns':
        fern(b, x, z, 0.4 * Math.max(0.8, placement.scale));
        fern(b, x + 0.45, z + 0.2, 0.34);
        break;
      case 'reeds':
        reeds(b, [x, WATER_LEVEL - 0.05, z], Math.round(10 * placement.scale), 0.5 * placement.scale);
        break;
      case 'lamp':
        lantern(b, at, { kind: lamps[estate.profile.house.style] ?? 'path' });
        break;
      case 'bench':
        bench(b, at, placement.facing);
        break;
      case 'nest':
        b.ring(0.2, 0.06, [x, 0.04, z], '#d2b060', { surface: 'thatch', rough: 1 }, [QUARTER, 0, 0]);
        b.dome([0.18, 0.04, 0.18], [x, 0.01, z], '#c4a45a', { surface: 'thatch', rough: 1 });
        break;
      case 'emblem':
        emblem(b, estate.profile.house.symbol, at);
        break;
      case 'keepsake':
        if (estate.profile.house.accent) keepsake(b, estate.profile.house.accent, at);
        break;
      case 'footbridge':
        footbridge(b, placement, estate);
        break;
      case 'jetty': {
        const { jetty: dock } = estate;
        jetty(b, [dock.x, 0.03, dock.z], dock.length, dock.width, { wood: '#8f7a62' }, placement.facing);
        break;
      }
      default:
        break;
    }
  }
}

/** A small arched bridge of planks where a path crosses the stream, rails along both sides. */
function footbridge(b: Builder, placement: Placement, estate: Estate): void {
  const span = estate.stream.width[1] + 1.6;
  const wide = placement.scale + 0.25;
  const rise = 0.26;
  b.group(
    [placement.at[0], 0, placement.at[1]],
    () => {
      const deck = (t: number): V3 => [0, 0.05 + Math.sin(t * Math.PI) * rise, -span / 2 + span * t];
      const planks = 14;
      for (let plank = 0; plank < planks; plank++) {
        const t = (plank + 0.5) / planks;
        b.box([wide, 0.04, span / planks - 0.015], deck(t), b.pick(['#9a7350', '#8f6a48', '#a37b55']), { ...WOOD, vary: 0.06 }, [-Math.atan((rise * Math.PI * Math.cos(t * Math.PI)) / span), 0, 0]);
      }
      for (const side of [-1, 1]) {
        const rail = (lift: number) => Array.from({ length: 9 }, (_, index): V3 => [side * (wide / 2 - 0.03), deck(index / 8)[1] + lift, deck(index / 8)[2]]);
        b.limb(rail(0.42), [0.025], '#7a5a42', { ...WOOD, sides: 6 });
        for (let post = 0; post <= 4; post++) b.box([0.045, 0.44, 0.045], [side * (wide / 2 - 0.03), deck(post / 4)[1] + 0.2, deck(post / 4)[2]], '#7a5a42', WOOD);
      }
    },
    placement.facing,
  );
}

/** The ground (or its first strip) and its shore: the bank dressed as the year branch says, headlands of big rocks, the beach clean. */
function drawGround(b: Builder, estate: Estate, site: EstateSite, paint: GroundPaint, strips = 1): void {
  estateGround(b, site, paint, { index: 0, of: strips });
  const { coast, plan } = estate;
  const shore = plan.shore;
  const perimeter = coast.radius(0) * TAU;
  const stones = Math.round(perimeter * (shore === 'rocks' ? 3.2 : shore === 'pebbles' ? 3.6 : shore === 'sand' ? 1.2 : 2.2));
  const landing = (x: number, z: number) =>
    estate.landings.some((item) => {
      const cos = Math.cos(item.bearing);
      const sin = Math.sin(item.bearing);
      return x * cos + z * sin > item.radius - 1.8 && Math.abs(z * cos - x * sin) < 1.3;
    }) || Math.hypot(x - estate.jetty.x, z - estate.jetty.z) < 1.4;
  for (let index = 0; index < stones; index++) {
    const bearing = -Math.PI + (index / stones) * TAU + b.between(-0.004, 0.004);
    if (coast.share(bearing, 'beach') > 0.35 || coast.share(bearing, 'mouth') > 0.4) continue;
    const point = coast.share(bearing, 'point');
    const big = b.random() < 0.1 + point * 0.4 + (shore === 'rocks' ? 0.1 : 0);
    const size = big ? b.between(0.5, 0.95) * (1 + point * 0.5) : shore === 'pebbles' ? b.between(0.1, 0.24) : b.between(0.14, 0.36);
    const inland = big ? b.between(-0.3, 0.3) : b.between(-0.45, 0.4);
    const [x, z] = coast.at(bearing, inland + 0.12);
    if (landing(x, z) || b.random() > b.density) continue;
    rock(b, [x, Math.max(site.height(x, z), WATER_LEVEL - 0.08) - 0.03, z], size, b.pick(ROCKS), b.between(0.55, 0.85));
  }
  // What the year branch dresses the top of the bank with, all round but where bridges land and on the beach.
  const tufts = Math.round(perimeter * 0.5);
  for (let index = 0; index < tufts; index++) {
    const bearing = -Math.PI + ((index + b.random()) / tufts) * TAU;
    const [x, z] = coast.at(bearing, coast.bank(bearing).lawn + 0.3 + b.random() * 0.6);
    if (landing(x, z)) continue;
    const beach = coast.share(bearing, 'beach');
    if (shore === 'shells' || beach > 0.3) {
      if (b.random() < 0.6) b.sprig('pad', [x, 0.02, z], b.between(0.06, 0.1), b.pick(['#f6d8d8', '#fbe9dc', '#f2e6cc']), [0, 1, 0], b.between(0, TAU));
    } else if (shore === 'ferns') fern(b, x, z, 0.38);
    else if (shore === 'flowers') flowerBed(b, [x, z], [0.4, 0.3], 4, plan.season.blooms, { height: [0.1, 0.22], size: 0.08 });
    else if (shore === 'grass') {
      for (let blade = 0; blade < 4; blade++) b.sprig('frond', [x + b.between(-0.15, 0.15), 0.02, z + b.between(-0.15, 0.15)], [0.5, b.between(0.6, 0.9), 0.5], b.pick(['#b3a862', '#c2b670', '#a39a55']), [b.between(-0.2, 0.2), 1, b.between(-0.2, 0.2)], b.between(0, TAU));
      b.sprig('puff', [x, 0.8, z], [0.06, 0.2, 0.06], '#efe6d6');
    } else if (shore === 'reeds' && index % 3 === 0) reeds(b, [coast.at(bearing, -0.3)[0], WATER_LEVEL - 0.05, coast.at(bearing, -0.3)[1]], 8, 0.4);
  }
}

/** Stones along the stream's banks, the spring's pool among rocks and ferns, the ponds dressed, fish and ripples. */
function drawWater(b: Builder, estate: Estate, site: EstateSite): void {
  const { stream } = estate;
  for (let index = 0; index < 70; index++) {
    const share = index / 70;
    const { at: point, heading } = pointAlong(stream.line, share);
    if (site.shore(point[0], point[1]) < 1.2) continue;
    const half = (stream.width[0] + (stream.width[1] - stream.width[0]) * share) / 2;
    for (const side of [-1, 1]) {
      if (b.random() < 0.35) continue;
      const away = half + b.between(0.05, 0.3);
      const x = point[0] - Math.sin(heading) * side * away;
      const z = point[1] + Math.cos(heading) * side * away;
      if (site.path(x, z).share > 0.05) continue;
      rock(b, [x, Math.max(-0.12, site.height(x, z)), z], b.between(0.18, 0.36), b.pick(ROCKS), 0.6);
    }
  }
  const [sx, sz] = stream.spring;
  for (let stone = 0; stone < 9; stone++) {
    const angle = (stone / 9) * TAU + b.between(-0.2, 0.2);
    rock(b, [sx + Math.cos(angle) * 1.05, 0, sz + Math.sin(angle) * 0.95], b.between(0.3, 0.6), b.pick(['#8f9299', '#a1a4aa', '#7e8188']), 0.75);
  }
  for (const [dx, dz] of [[-1.4, -0.6], [1.2, -1.1], [-0.6, -1.5]] as const) fern(b, sx + dx, sz + dz);
  b.life({ kind: 'ripples', at: [sx, WATER_LEVEL, sz], reach: 0.5 });
  for (const pond of estate.ponds) {
    dressPond(b, pond, ['#8f979c', '#a3aaae', '#7c858b']);
    lilies(b, [pond.x + 0.1, pond.z - 0.1], WATER_LEVEL, [pond.rx * 0.6, pond.rz * 0.5], 7);
    b.life({ kind: 'koi', at: [pond.x, 0, pond.z], reach: Math.min(pond.rx, pond.rz) * 0.55, color: '#ff8a3d', phase: 0 });
    b.life({ kind: 'koi', at: [pond.x + 0.2, 0, pond.z - 0.2], reach: Math.min(pond.rx, pond.rz) * 0.4, color: '#f6f2ea', phase: 2.6 });
  }
}

/** The garden's fence and gates, and (in the season of falling things) what drifts down over it. */
function drawGarden(b: Builder, estate: Estate, site: EstateSite): void {
  const garden = estate.zones.find((zone) => zone.part === 'month');
  if (!garden) return;
  const kinds: Record<string, 'picket' | 'rail' | 'bamboo'> = { wood: 'rail', fire: 'picket', earth: 'rail', metal: 'bamboo', water: 'picket' };
  const color = estate.profile.house.style === 'fire' || estate.profile.house.style === 'water' ? '#f1e9dc' : '#8a6648';
  fenceAbout(b, garden.box, (x, z) => site.path(x, z).share > 0 || site.pond(x, z) > -0.6, { kind: kinds[estate.profile.house.style] ?? 'picket', color, height: 0.5 });
  const { falling } = estate.plan.season;
  if (falling === 'petals' || falling === 'leaves') b.life({ kind: 'petals', at: [garden.label[0], 3.2, garden.label[1]], reach: 3.5, color: falling === 'petals' ? '#fbd0de' : '#d98a3a' });
}

/** The path's stones: stepping stones laid down the main path, a flat stone here and there on the trodden ones. */
function drawPaths(b: Builder, estate: Estate, site: EstateSite): void {
  const stones: Palette = estate.profile.house.style === 'metal' ? ['#cfcbc1', '#c2beb4', '#d8d4ca'] : ['#b5ab98', '#a39988', '#c2b8a6'];
  for (const path of estate.paths) {
    if (path.style === 'stones') {
      const points: [number, number][] = [];
      for (let index = 0; index <= 60; index++) {
        const { at } = pointAlong(path.line, index / 60);
        if (site.pond(at[0], at[1]) < -0.4 && site.shore(at[0], at[1]) > 0.6) points.push(at);
      }
      steppingStones(b, points, 0.56, stones);
    } else {
      const length = path.line.length * 0.4;
      const count = Math.round(length / 2.4);
      for (let index = 1; index < count; index++) {
        if (b.random() < 0.45) continue;
        const { at } = pointAlong(path.line, index / count);
        if (site.pond(at[0], at[1]) > -0.6 || site.shore(at[0], at[1]) < 0.8) continue;
        b.sprig('pebble', [at[0] + b.between(-0.15, 0.15), 0, at[1] + b.between(-0.15, 0.15)], [0.46, 0.12, 0.36], b.pick(stones), [0, 1, 0], b.between(0, TAU), [0, 1, 0], b.between(0.9, 1.08));
      }
    }
  }
}

/** Today's house without its island, about its own foot: what stands in for the houses builder's until it is there. */
export function standInHouse(estate: Estate, lush = true): Build {
  const { house } = estate.profile;
  const build = buildHome({ style: house.style, accent: house.accent, symbol: house.symbol }, lush, 'neighbour');
  const ground = new Set([surfaceMaps('ground').map, surfaceMaps('rock').map]);
  const meshes = build.meshes.filter(({ material }) => !ground.has((material as Material & { map?: unknown }).map as never));
  for (const { geometry } of meshes) geometry.translate(-HOUSE[0], 0, -HOUSE[2]);
  const sprigs = build.sprigs
    .filter(({ kind }) => kind !== 'rock' && kind !== 'pebble' && kind !== 'frond')
    .map((sprigs) => {
      const matrices = sprigs.matrices.slice();
      for (let index = 0; index < sprigs.count; index++) {
        matrices[index * 16 + 12]! -= HOUSE[0];
        matrices[index * 16 + 14]! -= HOUSE[2];
      }
      return { ...sprigs, matrices };
    });
  const shift = (at: V3): V3 => [at[0] - HOUSE[0], at[1], at[2] - HOUSE[2]];
  return { meshes, sprigs, lamps: build.lamps.map((lamp) => ({ ...lamp, at: shift(lamp.at) })), lives: build.lives.map((life) => ({ ...life, at: shift(life.at) })) };
}

/** The estate as parts to build, in the order the canvas builds them: the ground first, the house second. */
export function estateParts(estate: Estate, options: DrawOptions = {}): EstatePart[] {
  const lush = options.lush ?? true;
  const site = new EstateSite(estate);
  const paint = options.paint ?? seasonPaint(estate);
  const origin: V3 = [0, 0, 0];
  const builder = (key: EstatePartKey) => {
    const b = new Builder(estate.seed * 16 + SALT[key]);
    if (!lush) b.density = THIN;
    return b;
  };
  const part = (key: EstatePartKey, draw: (b: Builder) => void): EstatePart => ({
    key,
    at: origin,
    make: () => {
      const b = builder(key);
      draw(b);
      return b.finish();
    },
  });
  const strips = Math.max(1, Math.round(options.groundStrips ?? 1));
  const rest: EstatePart[] = Array.from({ length: strips - 1 }, (_, index) => ({
    key: `ground:${index + 1}` as const,
    at: origin,
    make: () => {
      const b = builder('ground');
      estateGround(b, site, paint, { index: index + 1, of: strips });
      return b.finish();
    },
  }));
  return [
    part('ground', (b) => drawGround(b, estate, site, paint, strips)),
    ...rest,
    { key: 'house', at: [estate.house.at[0], 0, estate.house.at[1]], make: options.house ?? (() => standInHouse(estate, lush)) },
    part('day', (b) => drawPlacements(b, estate, options, (placement) => placement.part === 'day')),
    part('paths', (b) => {
      drawPaths(b, estate, site);
      drawPlacements(b, estate, options, (placement) => placement.part === null);
    }),
    part('water', (b) => drawWater(b, estate, site)),
    part('month', (b) => {
      drawGarden(b, estate, site);
      drawPlacements(b, estate, options, (placement) => placement.part === 'month');
    }),
    part('hour', (b) => drawPlacements(b, estate, options, (placement) => placement.part === 'hour')),
    part('year', (b) => drawPlacements(b, estate, options, (placement) => placement.part === 'year')),
  ];
}
