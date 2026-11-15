import { Color } from 'three';

import type { Element } from '../elements';
import { boat, jetty, lantern, pot } from './arch';
import { Builder, type Build, type Finish, type V3 } from './build';
import { WATER_LEVEL } from './mood';
import { hash, noise2 } from './noise';
import { bush, flowerBed, lawn, lilies, pine, rock, steppingStones, toned, type Palette } from './plants';
import { dressShore, ground, Site, type GroundLook, type IslandShape } from './terrain';

// 깃발 섬: the island a village raises its flag on once its owner has ten 이웃. A small round island in the lake past
// the homes: a court of stone, a mast of bamboo on a dais of three steps, the flag in the colour of the owner's element,
// and lines of pennants in the five elements' colours from the mast's head down to posts round the shore. What stands
// still is built here as a home is (see homes). The cloth and the pennants move, and how they move is worked out here
// too, as plain numbers: the canvas only draws them (see Flag; this file is not `flag.ts` because beside `Flag.tsx` that
// would be the same name to a file system that ignores case).

const TAU = Math.PI * 2;
const QUARTER = Math.PI / 2;
const STONE: Finish = { surface: 'stone', rough: 0.88 };
const WOOD: Finish = { surface: 'wood', rough: 0.8 };
const BRONZE: Finish = { metal: 0.9, rough: 0.32 };
/** Gilding, as on the sun that stands in a 丙 garden: it keeps a little of its shine after dark. */
const GILT: Finish = { metal: 0.95, rough: 0.24, glow: '#ffcf70', power: 0.9 };
const GOLD = '#f2c55c';
const STONES: Palette = ['#d8d4ca', '#cfcbc1', '#c2beb4'];
const GREENS: Palette = ['#3f7a3c', '#4d8a45', '#366b36', '#5b9650'];
const LOOK: GroundLook = { lawn: ['#6a9a48', '#80ad55', '#9bbb66'], dirt: '#85694a', bank: '#a59b88', rocks: ['#9b968a', '#aca79a', '#88847b'] };
const GRASS: Palette = ['#6f9c46', '#85ae54', '#5f8b3c', '#9cbc62'];

const SEED = 97;
/** How thickly the island is planted for a device that would labour over a full one, as the homes are. */
const THIN = 0.62;
/** Tufts of grass tried over the island: as many to the square metre as over a home's. */
const LAWN_TUFTS = 1900;
/** From the island's middle to its shoreline, before the line wanders: six and a half metres of firm ground across. */
const SHORE = 3.3;
/** The island's ground as the lake meets it (see terrain's IslandShape): its shore is round, and its bank falls as a home's does. */
export const FLAG_ISLAND: IslandShape = { half: SHORE, corner: SHORE, reach: SHORE + 1.9 };
/** The paved court's radius, a step's height, and the dais' three steps from the widest up. */
const COURT = 1.8;
const RISE = 0.14;
const STEPS = [1.12, 0.84, 0.56] as const;
const DAIS = RISE * STEPS.length;
/** The mast's head, where the lines of pennants are made fast; the gilded finial stands above it. */
const HEAD: V3 = [0, 7.02, 0];
const BAMBOO = '#c9ad6b';
/** Where the jetty leaves the shore, on the side facing the village, and how far it runs out. */
const LANDING: V3 = [-2.75, 0.03, 0.25];
const JETTY = 1.7;

/** The way the wind blows over the lake, east and a little north: the way the homes' smoke drifts. */
const BLOW = Math.hypot(0.85, 0.5);
const WIND: readonly [number, number] = [0.85 / BLOW, -0.5 / BLOW];
/** The side of the flying cloth the camera sees, from its place in the south-east. */
const FACE: readonly [number, number] = [-WIND[1], WIND[0]];

/** How far the posts stand from the mast, and how high the lines come down to them. */
const POST_REACH = 2.72;
const POST_TOP = 1.05;
/** The first post's bearing: the cloth flies down the wind midway between two of the five lines, clear of both. */
const FIRST_POST = Math.atan2(WIND[1], WIND[0]) + TAU / 10;
/** The tops of the posts round the shore, five as the elements are, where the lines of pennants come down. */
export const POSTS: readonly V3[] = Array.from({ length: 5 }, (_, index): V3 => {
  const angle = FIRST_POST + (index / 5) * TAU;
  return [Math.cos(angle) * POST_REACH, POST_TOP, Math.sin(angle) * POST_REACH];
});

/** The flag's island: a round shore where a home's is a rounded square. Its bank and bed fall as a home's do. */
class Islet extends Site {
  override shore(x: number, z: number): number {
    const angle = Math.atan2(z, x);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const wander = (noise2(cos * 1.9 + this.seed * 3.7, sin * 1.9 + this.seed) - 0.5) * 0.5 + (noise2(cos * 5 + this.seed, sin * 5 - this.seed) - 0.5) * 0.2;
    return SHORE + wander - Math.hypot(x, z);
  }
}

/** The stretch of shore the jetty lands on, and the stones from it to the court: nothing is planted in their way. */
const landing = (x: number, z: number) => x < -COURT && Math.abs(z - LANDING[2]) < 0.6;

/** The court: flagstones inside a ring of kerbstones, and in its middle a round dais of three steps. */
function court(b: Builder): void {
  b.cyl(COURT, 0.04, [0, 0.012, 0], '#ffffff', { sides: 48, surface: 'masonry', rough: 0.9, shadowless: true });
  const kerbs = 30;
  for (let kerb = 0; kerb < kerbs; kerb++) {
    const angle = (kerb / kerbs) * TAU;
    b.box([0.33, 0.1, 0.15], [Math.cos(angle) * COURT, 0.045, Math.sin(angle) * COURT], b.pick(STONES), { ...STONE, vary: 0.05 }, -angle - QUARTER);
  }
  for (const [step, radius] of STEPS.entries()) b.cyl(radius, RISE, [0, RISE * (step + 0.5), 0], STONES[step % STONES.length]!, { ...STONE, sides: 40 });
}

/** The mast: a great cane of bamboo held between two stone posts (당간지주), a gilded bud at its head. */
function mast(b: Builder): void {
  // The posts stand to either side of the cane as the camera sees it, a bronze pin through all three.
  b.group(
    [0, DAIS, 0],
    () => {
      b.box([0.5, 0.14, 0.4], [0, 0.07, 0], STONES[1]!, STONE);
      for (const side of [-1, 1]) {
        b.box([0.12, 0.95, 0.26], [side * 0.18, 0.14 + 0.475, 0], STONES[0]!, STONE);
        b.prism([0.12, 0.09, 0.26], [side * 0.18, 1.09, 0], STONES[0]!, { ...STONE, ridge: 1 });
      }
      for (const y of [0.5, 0.88]) b.cyl(0.02, 0.56, [0, y, 0], '#7d6032', { ...BRONZE, sides: 8 }, [0, 0, QUARTER]);
    },
    Math.PI / 4,
  );
  const tall = HEAD[1] - DAIS;
  const foot = 0.085;
  const top = 0.046;
  b.cyl(foot, tall, [0, DAIS + tall / 2, 0], BAMBOO, { top, sides: 14, rough: 0.5 });
  const joints = 15;
  for (let joint = 1; joint < joints; joint++) {
    const up = joint / joints;
    b.cyl(foot + (top - foot) * up + 0.005, 0.024, [0, DAIS + tall * up, 0], toned(BAMBOO, 0.6), { sides: 14, rough: 0.5 });
  }
  // The head: a collar, the truck the lines are made fast to, and the bud.
  b.cyl(0.058, 0.09, [0, HEAD[1] - 0.06, 0], '#b98a45', { ...BRONZE, sides: 12 });
  b.cyl(0.11, 0.034, [0, HEAD[1], 0], GOLD, { ...GILT, sides: 16 });
  b.ball(0.105, [0, HEAD[1] + 0.15, 0], GOLD, { ...GILT, scale: [1, 1.2, 1], detail: 14 });
  b.cone(0.04, 0.17, [0, HEAD[1] + 0.35, 0], GOLD, { ...GILT, sides: 10 });
  // The halyard, down the mast's lee side to its cleat.
  const out = 0.1;
  b.limb([[WIND[0] * 0.07, HEAD[1] - 0.12, WIND[1] * 0.07], [WIND[0] * out, 3.6, WIND[1] * out], [WIND[0] * out, 1.75, WIND[1] * out]], [0.007], '#e9dcc0', { sides: 4, shadowless: true });
  b.box([0.05, 0.035, 0.14], [WIND[0] * out, 1.72, WIND[1] * out], '#7d6032', BRONZE, Math.atan2(-WIND[1], WIND[0]) + QUARTER);
}

/** The posts the lines come down to, a paper lantern hung from each. */
function posts(b: Builder, site: Site): void {
  for (const [x, top, z] of POSTS) {
    const foot = site.height(x, z) - 0.25;
    const turn = Math.atan2(-z, x);
    b.cyl(0.05, top - foot, [x, (top + foot) / 2, z], '#6b4a35', { top: 0.04, sides: 8, surface: 'wood', rough: 0.8 });
    b.ball(0.055, [x, top + 0.03, z], '#c79a4a', { ...BRONZE, detail: 8 });
    // The lantern hangs inside the line, off a short arm.
    b.group(
      [x, 0, z],
      () => {
        b.box([0.34, 0.035, 0.035], [-0.13, top - 0.1, 0], '#6b4a35', WOOD);
        b.group([-0.27, top - 0.42, 0], () => lantern(b, [0, 0, 0], { kind: 'paper', light: '#ffd9a0', power: 0.8 }), 0, 1.45);
      },
      turn,
    );
  }
}

/** The island with its court, mast, posts, lanterns, planting, jetty and boat: everything of it that stands still. */
export function buildFlagIsland(lush = true): Build {
  const b = new Builder(SEED);
  if (!lush) b.density = THIN;
  const site = new Islet(SEED);
  /** The bearing midway between one post and the next: 0 the gap nearest the camera, 4 the one the cloth flies over. */
  const between = (gap: number) => FIRST_POST + (gap + 0.5) * (TAU / 5);
  ground(b, site, LOOK);
  // A small pine at the back, between two posts. It is planted first, so it grows the same whatever else is added.
  const pineAt: V3 = [Math.cos(between(3)) * 2.45, 0, Math.sin(between(3)) * 2.45];
  pine(b, pineAt, { height: 2.5, spread: 1.6, needles: ['#3f6b4a', '#4a7a55', '#335c40', '#5a8a62'] });
  court(b);
  mast(b);
  posts(b, site);

  // The landing: a jetty toward the village with a boat made fast to it, and stones from its head to the court.
  jetty(b, LANDING, JETTY, 0.6, { wood: '#8f7a62' }, -QUARTER);
  boat(b, [LANDING[0] - JETTY + 0.5, WATER_LEVEL, LANDING[2] + 0.72], 0.2, '#6b4a35');
  b.life({ kind: 'ripples', at: [LANDING[0] - JETTY + 0.3, WATER_LEVEL, LANDING[2] + 1.3], reach: 0.8 });
  steppingStones(b, [[LANDING[0] + 0.1, LANDING[2]], [-COURT - 0.05, LANDING[2] - 0.08]], 0.44, STONES);
  // On the court: a stone lantern to either side of the dais as the camera sees it, and flowers in pots where the path comes in.
  for (const bearing of [Math.PI / 4 - 0.66, Math.PI / 4 + 0.66]) lantern(b, [Math.cos(bearing) * 1.46, 0.03, Math.sin(bearing) * 1.46], { kind: 'stone', light: '#ffe2b0' });
  pot(b, [-1.42, 0.03, LANDING[2] + 0.62], 1, GREENS, ['#ff8fa3', '#ffffff', '#ffd9d9']);
  pot(b, [-1.42, 0.03, LANDING[2] - 0.62], 1, GREENS, ['#ffd95a', '#fff0a0', '#ffffff']);

  // Shrubs in flower between the other posts, and flowers in a wreath about the court.
  const shrubs: [bearing: number, away: number, radius: number, blooms: Palette][] = [
    [between(0), 2.5, 0.42, ['#f7a8c4', '#fbd0de', '#e87aa4']],
    [between(1), 2.45, 0.36, ['#ffffff', '#fbe9f0']],
    [between(4), 2.5, 0.38, ['#ffd95a', '#fff0a0']],
  ];
  for (const [bearing, away, radius, blooms] of shrubs) bush(b, [Math.cos(bearing) * away, 0, Math.sin(bearing) * away], radius, GREENS, { colors: blooms, count: Math.round(radius * 34) });
  const planted = (x: number, z: number) =>
    Math.hypot(x - pineAt[0], z - pineAt[2]) < 0.3 || shrubs.some(([bearing, away, radius]) => Math.hypot(x - Math.cos(bearing) * away, z - Math.sin(bearing) * away) < radius + 0.1);
  const wreath = (x: number, z: number) => {
    const away = Math.hypot(x, z);
    return away > COURT + 0.2 && away < COURT + 0.62 && !landing(x, z) && !planted(x, z) && site.shore(x, z) > 0.55;
  };
  flowerBed(b, [0, 0], [COURT + 0.62, COURT + 0.62], Math.round(360 * b.density), ['#ffffff', '#ffd95a', '#ff8fa3', '#c9a0ff', '#fff0a0'], { height: [0.14, 0.3], keep: wreath });
  for (const [x, z, size] of [[-1.45, -2.2, 0.5], [-2.8, -1.2, 0.34], [1.55, 2.3, 0.32]] as const) rock(b, [x, 0, z], size, b.pick(LOOK.rocks), 0.7);
  // Lilies afloat off the near shore.
  for (const [bearing, count] of [[between(1) - 0.2, 6], [between(0) - 0.45, 4]] as const) lilies(b, [Math.cos(bearing) * 4.05, Math.sin(bearing) * 4.05], WATER_LEVEL, [0.5, 0.36], count);
  b.life({ kind: 'fireflies', at: [-1.2, 0.6, -1.9], reach: 1.2, count: 6 });
  b.life({ kind: 'fireflies', at: [1.7, 0.5, 1.6], reach: 1.1, count: 4 });
  b.life({ kind: 'butterfly', at: [1.5, 0.55, 1.75], color: '#fff3b0', phase: 0.8 });

  // The shore is a home's in little: its stones are thinned to the shorter line, and the landing is left clear.
  const sparse = (x: number, z: number) => hash(Math.round(x * 50), Math.round(z * 50), SEED) < 0.45;
  dressShore(b, site, LOOK, (x, z) => landing(x, z) || sparse(x, z));
  const open = (x: number, z: number) => site.open(x, z) && Math.hypot(x, z) > COURT + 0.12 && !landing(x, z);
  lawn(b, open, LAWN_TUFTS, GRASS, { half: 3.8 });
  return b.finish();
}

// The cloth. It is a strip made fast along its hoist and bent by the wind: each row is laid out from the mast a short
// step at a time, every step turned from the wind's line by the waves passing along it. The cloth so keeps its length
// however it folds, the hoist never moves, and what the waves add up to is greatest at the free end.

/** The flag's cloth: its length along the wind and its height, in metres, and how finely it is cut to bend. */
export const CLOTH = { length: 3, height: 2, columns: 36, rows: 12 } as const;
/** The cloth's upper corner at the mast, and how far off the mast's middle its hoist is held. */
const HOIST_TOP = 6.84;
const HOIST_OUT = 0.075;

/** How far the cloth is turned from the wind's line `u` of the way along it and `v` of the way up it, in radians. */
function bendAt(u: number, v: number, time: number): number {
  // Slack toward the fly and along the foot, taut at the hoist and the head.
  const reach = (0.3 + 0.7 * u) * (1.25 - 0.25 * v);
  // Three trains of waves running from hoist to fly, their crests leaning: broad folds, the ripples over them, a flutter.
  return reach * (0.6 * Math.sin(11.5 * u - 4.2 * time + 1.6 * v) + 0.32 * Math.sin(19 * u - 7.9 * time - 2.3 * v + 1.3) + 0.16 * Math.sin(31 * u - 13.5 * time + 1.1 * v + 4));
}

/**
 * Where the cloth is at `time` and how it faces, written into `positions` and `normals` (three numbers a corner, row
 * by row from the foot, each row from the hoist), about the island's middle. The same moment gives the same cloth.
 */
export function fly(time: number, positions: Float32Array, normals: Float32Array): void {
  const { length, height, columns, rows } = CLOTH;
  const step = length / columns;
  const wide = columns + 1;
  // The wind veers a little and drops a little, slowly: the whole cloth swings about the mast and sinks with it.
  const swing = 0.1 * Math.sin(time * 0.47) + 0.06 * Math.sin(time * 1.07 + 2.1);
  const lull = 0.04 * Math.sin(time * 0.6 + 0.5);
  for (let row = 0; row <= rows; row++) {
    const v = row / rows;
    let x = WIND[0] * HOIST_OUT;
    let y = HOIST_TOP - (1 - v) * height;
    let z = WIND[1] * HOIST_OUT;
    let at = row * wide * 3;
    positions[at] = x;
    positions[at + 1] = y;
    positions[at + 2] = z;
    for (let column = 1; column <= columns; column++) {
      const u = (column - 0.5) / columns;
      const bend = swing + bendAt(u, v, time);
      // Its own weight draws it down, more the farther from the mast.
      const droop = 0.1 + 0.26 * u + lull;
      const flat = Math.cos(bend) * Math.cos(droop);
      x += step * (flat * WIND[0] + Math.sin(bend) * FACE[0]);
      y -= step * Math.cos(bend) * Math.sin(droop);
      z += step * (flat * WIND[1] + Math.sin(bend) * FACE[1]);
      at += 3;
      positions[at] = x;
      positions[at + 1] = y;
      positions[at + 2] = z;
    }
  }
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const at = (row * wide + column) * 3;
      const before = (row * wide + Math.max(0, column - 1)) * 3;
      const after = (row * wide + Math.min(columns, column + 1)) * 3;
      const below = (Math.max(0, row - 1) * wide + column) * 3;
      const above = (Math.min(rows, row + 1) * wide + column) * 3;
      const ax = positions[after]! - positions[before]!;
      const ay = positions[after + 1]! - positions[before + 1]!;
      const az = positions[after + 2]! - positions[before + 2]!;
      const ux = positions[above]! - positions[below]!;
      const uy = positions[above + 1]! - positions[below + 1]!;
      const uz = positions[above + 2]! - positions[below + 2]!;
      const nx = ay * uz - az * uy;
      const ny = az * ux - ax * uz;
      const nz = ax * uy - ay * ux;
      const size = Math.hypot(nx, ny, nz) || 1;
      normals[at] = nx / size;
      normals[at + 1] = ny / size;
      normals[at + 2] = nz / size;
    }
  }
}

export type Shape = { positions: Float32Array; normals: Float32Array; indices: Uint16Array };

/** The cloth as a mesh, flown as at the first moment: its corners, how they face, where its picture falls and its faces. */
export function clothShape(): Shape & { uvs: Float32Array } {
  const { columns, rows } = CLOTH;
  const wide = columns + 1;
  const positions = new Float32Array(wide * (rows + 1) * 3);
  const normals = new Float32Array(positions.length);
  const uvs = new Float32Array(wide * (rows + 1) * 2);
  const indices = new Uint16Array(columns * rows * 6);
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      uvs[(row * wide + column) * 2] = column / columns;
      uvs[(row * wide + column) * 2 + 1] = row / rows;
    }
  }
  let next = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const a = row * wide + column;
      indices.set([a, a + 1, a + wide + 1, a, a + wide + 1, a + wide], next);
      next += 6;
    }
  }
  fly(0, positions, normals);
  return { positions, normals, uvs, indices };
}

// The cloth's picture: the field in its colour, a paler band above and below, and in the middle a pale disc with the
// element's character brushed on it. It is painted texel by texel from distances, so it needs no canvas and no font.

type Rgb = [number, number, number];

/** The cloth's colours as paint (0 to 1, as a hex code writes them): its field, the paler band, the disc and the ink. */
export type ClothColors = { field: Rgb; band: Rgb; disc: Rgb; ink: Rgb };

/** A flag in `field` (the app's colour for an element): the band and the disc are the same colour let down with white, the ink the same colour deepened. */
export function clothColors(field: string): ClothColors {
  const paint = new Color(field).convertLinearToSRGB();
  const base: Rgb = [paint.r, paint.g, paint.b];
  const paler = (by: number): Rgb => [base[0] + (1 - base[0]) * by, base[1] + (1 - base[1]) * by, base[2] + (1 - base[2]) * by];
  return { field: base, band: paler(0.5), disc: paler(0.88), ink: [base[0] * 0.36, base[1] * 0.36, base[2] * 0.36] };
}

/** The name the app's stylesheet gives the colour a flag is flown in: its element's, or the app's own before a home is built. */
export const flagToken = (element: Element | null) => (element ? `--mg-${element}` : '--mg-primary');

/**
 * A brush stroke of a character, in the disc's own measure (its middle at 0, its rim at 1, y upward): how the brush is
 * carried (`h` across, `v` down, `l` falling away to the left and thinning, `r` falling to the right and pressed, `d` a
 * dot), then where it starts and ends, or starts, bends and ends.
 */
type Stroke = readonly ['h' | 'v' | 'l' | 'r' | 'd', ...number[]];

/** The five characters, each brushed as heavily as its strokes leave room for, and all of it inside the seal's ring. */
const GLYPHS: Record<Element, { weight: number; strokes: readonly Stroke[] }> = {
  /** 木 */
  wood: { weight: 0.112, strokes: [['h', -0.6, 0.2, 0.6, 0.24], ['v', 0, 0.68, 0, -0.68], ['l', -0.04, 0.18, -0.2, -0.2, -0.62, -0.5], ['r', 0.04, 0.18, 0.22, -0.18, 0.64, -0.5]] },
  /** 火 */
  fire: { weight: 0.112, strokes: [['d', -0.52, 0.36, -0.36, 0.08], ['l', 0.52, 0.4, 0.3, 0.1], ['l', 0.02, 0.68, 0.02, -0.06, -0.62, -0.6], ['r', 0.03, 0.14, 0.16, -0.28, 0.64, -0.58]] },
  /** 土 */
  earth: { weight: 0.118, strokes: [['h', -0.38, 0.12, 0.38, 0.15], ['v', 0, 0.64, 0, -0.5], ['h', -0.6, -0.5, 0.6, -0.48]] },
  /** 金 */
  metal: {
    weight: 0.086,
    strokes: [
      ['l', 0, 0.72, -0.2, 0.44, -0.68, 0.18],
      ['r', 0, 0.72, 0.2, 0.44, 0.7, 0.16],
      ['h', -0.27, 0.2, 0.27, 0.21],
      ['h', -0.43, -0.07, 0.43, -0.06],
      ['v', 0, 0.2, 0, -0.58],
      ['d', -0.4, -0.2, -0.27, -0.42],
      ['l', 0.4, -0.18, 0.25, -0.43],
      ['h', -0.58, -0.6, 0.58, -0.58],
    ],
  },
  /** 水 */
  water: {
    weight: 0.108,
    strokes: [['v', 0, 0.7, 0, -0.6], ['l', 0, -0.6, -0.17, -0.42], ['h', -0.62, 0.22, -0.16, 0.24], ['l', -0.16, 0.24, -0.24, -0.1, -0.62, -0.42], ['l', 0.54, 0.44, 0.08, 0.08], ['r', 0.08, 0.08, 0.24, -0.2, 0.66, -0.5]],
  },
};

/** How thick the brush is `along` a stroke (0 its start, 1 its end), against the character's weight. */
function brush(kind: Stroke[0], along: number): number {
  if (kind === 'h') return 0.86 + 0.24 * Math.abs(along * 2 - 1) ** 1.5;
  if (kind === 'v') return 1.08 - 0.3 * along;
  if (kind === 'l') return 1.1 - 0.82 * along;
  if (kind === 'd') return 0.55 + 0.75 * along;
  return (0.5 + 0.95 * along) * (along > 0.8 ? 1 - ((along - 0.8) / 0.2) * 0.7 : 1);
}

type Mark = { ax: number; ay: number; bx: number; by: number; ra: number; rb: number };

/** A character's strokes as short straight marks, each with the brush's thickness at its two ends. */
function marksOf(element: Element): Mark[] {
  const { weight, strokes } = GLYPHS[element];
  const marks: Mark[] = [];
  for (const [kind, ...points] of strokes) {
    const bent = points.length === 6;
    const [x0, y0, x1, y1, x2, y2] = bent ? (points as [number, number, number, number, number, number]) : [points[0]!, points[1]!, (points[0]! + points[2]!) / 2, (points[1]! + points[3]!) / 2, points[2]!, points[3]!];
    const pieces = bent ? 10 : 4;
    const at = (t: number): [number, number] => [(1 - t) ** 2 * x0 + 2 * t * (1 - t) * x1 + t * t * x2, (1 - t) ** 2 * y0 + 2 * t * (1 - t) * y1 + t * t * y2];
    for (let piece = 0; piece < pieces; piece++) {
      const [from, to] = [piece / pieces, (piece + 1) / pieces];
      const [ax, ay] = at(from);
      const [bx, by] = at(to);
      marks.push({ ax, ay, bx, by, ra: weight * brush(kind, from), rb: weight * brush(kind, to) });
    }
  }
  return marks;
}

/** How far (x, y) lies outside the nearest of `marks`; negative inside one. */
function inkAt(marks: readonly Mark[], x: number, y: number): number {
  let nearest = 9;
  for (const { ax, ay, bx, by, ra, rb } of marks) {
    const dx = bx - ax;
    const dy = by - ay;
    const along = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    nearest = Math.min(nearest, Math.hypot(x - ax - dx * along, y - ay - dy * along) - (ra + (rb - ra) * along));
  }
  return nearest;
}

/** The cloth's picture is this many texels along the fly and up the hoist. */
export const CLOTH_TEXELS = { width: 512, height: 256 } as const;
/**
 * The bands' height and how far in from the head and the foot they run; the disc's middle along the fly and its radius;
 * all in metres. The disc takes what the bands leave of the cloth's height and its character is brushed heavily: from
 * across the village a metre of cloth is some sixteen pixels, and a finer mark is lost on the way.
 */
const BAND = { from: 0.07, height: 0.15 } as const;
const DISC = { x: 1.42, radius: 0.72 } as const;
/** The strip of canvas the cloth is sewn to at the hoist. */
const HEADING = 0.075;

const cover = (edge: number, value: number, soft: number) => Math.min(1, Math.max(0, (edge - value) / soft + 0.5));

/**
 * The cloth's picture as texels (four bytes each, row by row from the foot, each row from the hoist): `colors` over
 * the field, the bands and the disc, and the character of `element` on the disc (the disc is left bare when there is
 * none yet).
 */
export function paintCloth(colors: ClothColors, element: Element | null): Uint8Array {
  const { width, height } = CLOTH_TEXELS;
  const data = new Uint8Array(width * height * 4);
  const marks = element ? marksOf(element) : [];
  const texel = CLOTH.length / width;
  const middle = CLOTH.height / 2;
  const mix = (into: Rgb, color: Rgb, share: number) => {
    into[0] += (color[0] - into[0]) * share;
    into[1] += (color[1] - into[1]) * share;
    into[2] += (color[2] - into[2]) * share;
  };
  const color: Rgb = [0, 0, 0];
  for (let row = 0; row < height; row++) {
    const y = ((row + 0.5) / height) * CLOTH.height;
    // The two bands mirror each other about the cloth's middle.
    const inBand = cover(BAND.height / 2, Math.abs(Math.abs(y - middle) - (middle - BAND.from - BAND.height / 2)), CLOTH.height / height);
    for (let column = 0; column < width; column++) {
      const x = ((column + 0.5) / width) * CLOTH.length;
      color[0] = colors.field[0];
      color[1] = colors.field[1];
      color[2] = colors.field[2];
      mix(color, colors.band, inBand);
      const away = Math.hypot(x - DISC.x, y - middle);
      if (away < DISC.radius + texel * 2) {
        mix(color, colors.disc, cover(DISC.radius, away, texel));
        const gx = (x - DISC.x) / DISC.radius;
        const gy = (y - middle) / DISC.radius;
        const soft = texel / DISC.radius;
        // A fine ring inside the disc's rim, as a seal has, and the character.
        mix(color, colors.ink, cover(0.012, Math.abs(away / DISC.radius - 0.93), soft) * 0.85);
        mix(color, colors.ink, cover(0, inkAt(marks, gx, gy), soft));
      }
      mix(color, colors.disc, cover(HEADING, x, texel));
      // Dyed cloth is never quite even.
      const dye = 0.972 + (noise2(x * 2.3 + 3, y * 2.3 + 11) * 0.6 + noise2(x * 9.7, y * 9.7 + 5) * 0.4) * 0.056;
      const at = (row * width + column) * 4;
      data[at] = Math.round(Math.min(1, color[0] * dye) * 255);
      data[at + 1] = Math.round(Math.min(1, color[1] * dye) * 255);
      data[at + 2] = Math.round(Math.min(1, color[2] * dye) * 255);
      data[at + 3] = 255;
    }
  }
  return data;
}

// The lines of pennants. Each hangs in a shallow curve from the mast's head to its post and gives a little to the wind;
// each pennant is sewn to its line along its top and hangs square off it, swung to leeward and fluttering.

/** How far a line sags below its own straight run at its middle, and a pennant's width along its line and its fall from it, in metres. */
const SAG = 0.24;
const PENNANT = { width: 0.25, fall: 0.34, every: 0.36 } as const;
/** Pennants begin far enough down the line to hang clear of the mast (lower on three of the lines: see LINES), and stop short of the post. */
const DRESSED = { from: 0.18, to: 0.95 } as const;
const ROPE = { radius: 0.011, rings: 13, sides: 3 } as const;
/** How far round its line the full wind swings a pennant, in radians. */
const BLOWN = 0.8;

type Line = {
  post: V3;
  /** Along the line from the head, square off it downward, and level across it: the three ways a pennant is placed by. */
  along: V3;
  down: V3;
  across: V3;
  /** How squarely the wind takes the line's pennants: 1 full on from one side, -1 from the other, 0 along the line. */
  lee: number;
  /** How far down the line its first pennant's place begins (0 the mast's head, 1 the post). */
  from: number;
  pennants: number;
};

const LINES: readonly Line[] = POSTS.map((post) => {
  const run: V3 = [post[0] - HEAD[0], post[1] - HEAD[1], post[2] - HEAD[2]];
  const length = Math.hypot(run[0], run[1], run[2]);
  const along: V3 = [run[0] / length, run[1] / length, run[2] / length];
  // Square off the line and as far downward as that allows: the way a pennant sewn along it hangs.
  const fall = Math.hypot(along[1] * along[0], along[1] * along[1] - 1, along[1] * along[2]);
  const down: V3 = [(along[1] * along[0]) / fall, (along[1] * along[1] - 1) / fall, (along[1] * along[2]) / fall];
  const across: V3 = [along[1] * down[2] - along[2] * down[1], along[2] * down[0] - along[0] * down[2], along[0] * down[1] - along[1] * down[0]];
  // How nearly the line runs out the way the wind blows: 1 straight down the wind, -1 straight up it.
  const downwind = (run[0] * WIND[0] + run[2] * WIND[1]) / Math.hypot(run[0], run[2]);
  // The cloth flies between the two lines that run out down the wind, and the wind swings their pennants in toward it:
  // those lines are dressed only from where they have come down past the cloth's foot. On the line that runs straight
  // up the wind nothing swings the pennants aside and the wind leans the line itself on the mast: there they begin a
  // place lower than on the rest.
  const from = downwind > 0 ? (HEAD[1] - (HOIST_TOP - CLOTH.height)) / -run[1] : downwind < -0.9 ? DRESSED.from + PENNANT.every / length : DRESSED.from;
  return { post, along, down, across, lee: WIND[0] * across[0] + WIND[1] * across[2], from, pennants: Math.floor((length * (DRESSED.to - from)) / PENNANT.every) };
});

/** How many pennants fly in all. */
export const PENNANTS = LINES.reduce((sum, line) => sum + line.pennants, 0);
const ROPE_CORNERS = LINES.length * ROPE.rings * ROPE.sides;

const spot: V3 = [0, 0, 0];
/** Where `line` is `t` of the way from the mast's head to its post at `time`, left in {@link spot}. */
function lineAt(line: Line, index: number, t: number, time: number): void {
  const span = 4 * t * (1 - t);
  // The wind leans on the middle of the line, harder and softer by turns, and a shiver runs down it.
  const push = span * (0.07 + 0.045 * Math.sin(time * 0.83 + index * 1.7) + 0.02 * Math.sin(time * 1.9 + t * 6 + index));
  const sag = SAG * span;
  spot[0] = HEAD[0] + (line.post[0] - HEAD[0]) * t + line.down[0] * sag + WIND[0] * push;
  spot[1] = HEAD[1] + (line.post[1] - HEAD[1]) * t + line.down[1] * sag;
  spot[2] = HEAD[2] + (line.post[2] - HEAD[2]) * t + line.down[2] * sag + WIND[1] * push;
}

/**
 * Where the lines and their pennants are at `time` and how the pennants face, written into `positions` and `normals`
 * (the lines' corners first, then three to a pennant), about the island's middle. The same moment gives the same lines.
 */
export function flutter(time: number, positions: Float32Array, normals: Float32Array): void {
  let at = 0;
  for (let index = 0; index < LINES.length; index++) {
    const line = LINES[index]!;
    for (let ring = 0; ring < ROPE.rings; ring++) {
      lineAt(line, index, ring / (ROPE.rings - 1), time);
      for (let side = 0; side < ROPE.sides; side++) {
        // The rope's own roundness was set down once with its normals (see buntingShape): it is carried along whole.
        positions[at] = spot[0] + normals[at]! * ROPE.radius;
        positions[at + 1] = spot[1] + normals[at + 1]! * ROPE.radius;
        positions[at + 2] = spot[2] + normals[at + 2]! * ROPE.radius;
        at += 3;
      }
    }
  }
  for (let index = 0; index < LINES.length; index++) {
    const line = LINES[index]!;
    const { down, across } = line;
    const each = (DRESSED.to - line.from) / line.pennants;
    const half = (each * PENNANT.width) / PENNANT.every / 2;
    for (let pennant = 0; pennant < line.pennants; pennant++) {
      const t = line.from + (pennant + 0.5) * each;
      const phase = index * 2.3 + pennant * 1.9;
      lineAt(line, index, t - half, time);
      const ax = spot[0];
      const ay = spot[1];
      const az = spot[2];
      lineAt(line, index, t + half, time);
      const bx = spot[0];
      const by = spot[1];
      const bz = spot[2];
      // Swung round its line to leeward as the wind takes it, and fluttering about that.
      const swung = BLOWN * line.lee * (0.82 + 0.18 * Math.sin(time * 0.9 + index)) + 0.3 * Math.sin(time * 3.3 + phase) + 0.14 * Math.sin(time * 5.9 + phase * 1.7);
      const cos = Math.cos(swung) * PENNANT.fall;
      const sin = Math.sin(swung) * PENNANT.fall;
      const cx = (ax + bx) / 2 + down[0] * cos + across[0] * sin;
      const cy = (ay + by) / 2 + down[1] * cos + across[1] * sin;
      const cz = (az + bz) / 2 + down[2] * cos + across[2] * sin;
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const size = Math.hypot(nx, ny, nz) || 1;
      positions[at] = ax;
      positions[at + 1] = ay;
      positions[at + 2] = az;
      positions[at + 3] = bx;
      positions[at + 4] = by;
      positions[at + 5] = bz;
      positions[at + 6] = cx;
      positions[at + 7] = cy;
      positions[at + 8] = cz;
      for (let corner = 0; corner < 9; corner += 3) {
        normals[at + corner] = nx / size;
        normals[at + corner + 1] = ny / size;
        normals[at + corner + 2] = nz / size;
      }
      at += 9;
    }
  }
}

/**
 * The lines and their pennants as one mesh, hung as at the first moment. `threads` joins the same corners in pairs down
 * each line: the rope as a bare line, for where it is too far off to be drawn as thick as it is.
 */
export function buntingShape(): Shape & { threads: Uint16Array } {
  const corners = ROPE_CORNERS + PENNANTS * 3;
  const positions = new Float32Array(corners * 3);
  const normals = new Float32Array(corners * 3);
  const indices: number[] = [];
  const threads: number[] = [];
  let at = 0;
  for (const [index, line] of LINES.entries()) {
    for (let ring = 0; ring < ROPE.rings; ring++) {
      for (let side = 0; side < ROPE.sides; side++) {
        const angle = (side / ROPE.sides) * TAU;
        normals[at] = line.down[0] * Math.cos(angle) + line.across[0] * Math.sin(angle);
        normals[at + 1] = line.down[1] * Math.cos(angle) + line.across[1] * Math.sin(angle);
        normals[at + 2] = line.down[2] * Math.cos(angle) + line.across[2] * Math.sin(angle);
        at += 3;
        if (ring === ROPE.rings - 1) continue;
        const a = (index * ROPE.rings + ring) * ROPE.sides + side;
        const b = (index * ROPE.rings + ring) * ROPE.sides + ((side + 1) % ROPE.sides);
        // Wound so that each face looks out of the rope, the way its corners do.
        indices.push(a, b, a + ROPE.sides, b, b + ROPE.sides, a + ROPE.sides);
        if (side === 0) threads.push(a, a + ROPE.sides);
      }
    }
  }
  for (let corner = ROPE_CORNERS; corner < corners; corner++) indices.push(corner);
  flutter(0, positions, normals);
  return { positions, normals, indices: new Uint16Array(indices), threads: new Uint16Array(threads) };
}

/** The colour of every corner of {@link buntingShape}, as light: the lines in `rope`, the pennants in `colors` by turns. */
export function buntingColors(colors: readonly string[], rope = '#3a3331'): Float32Array {
  const tints = new Float32Array((ROPE_CORNERS + PENNANTS * 3) * 3);
  const paint = new Color(rope);
  for (let corner = 0; corner < ROPE_CORNERS; corner++) paint.toArray(tints, corner * 3);
  let at = ROPE_CORNERS * 3;
  for (const [index, line] of LINES.entries()) {
    for (let pennant = 0; pennant < line.pennants; pennant++) {
      paint.set(colors[(pennant + index * 2) % colors.length] ?? rope);
      for (let corner = 0; corner < 3; corner++, at += 3) paint.toArray(tints, at);
    }
  }
  return tints;
}

// The island as one thing: what the pointer meets of it, and how it comes to a village that is already on screen.

/**
 * What the pointer meets of the island, in place of the thousands of shapes on it: a cone from the water up past the
 * finial, which holds the ground, the mast and the lines of pennants, and a box about the cloth, which flies out of the
 * cone. Whatever of the island the camera can draw before a home stands inside the two (see Flag).
 */
export const HULL = {
  /** The cone: the heights of its foot and its tip, its radius at the foot, and how many flat sides it is drawn with. */
  cone: { foot: WATER_LEVEL, tip: 7.6, radius: 3.6, sides: 16 },
  /**
   * The box: how far it runs from the mast down the wind, the heights of its foot (the fly end sinks well below the
   * hoist's) and its head, how far it reaches to either side of the wind's line, and the turn about the mast that
   * lays it along the wind.
   */
  cloth: { length: CLOTH.length, foot: HOIST_TOP - CLOTH.height - 0.85, head: HOIST_TOP + 0.04, half: 0.75, turn: Math.atan2(-WIND[1], WIND[0]) },
} as const;

/** How long an island raised in a village already on screen takes to come up out of the lake, in seconds. */
export const RISE_SECONDS = 1.8;

/**
 * How far below its place such an island stands `seconds` after it began to come up: under the lake by the whole
 * height of its hull at first (its finial just covered), slow to leave and slow to arrive, and in its place from
 * {@link RISE_SECONDS} on.
 */
export function sunk(seconds: number): number {
  const t = Math.min(1, Math.max(0, seconds / RISE_SECONDS));
  return (1 - t * t * (3 - 2 * t)) * (HULL.cone.tip - HULL.cone.foot);
}
