import { Color } from 'three';

import type { Builder, Finish } from './build';
import { HOME_HALF } from './estate/coast';
import { WATER_LEVEL } from './mood';
import { noise2 } from './noise';
import { reeds, rock, type Palette } from './plants';

// An island's ground: a lawn at y = 0, a bank of earth and stones wandering down to the lake, and the bed going on
// under the water until it is lost in the deep. A pond is a hollow in the lawn that reaches below the lake's level, so
// the lake's own water stands in it.

/** A pond: an oval hollow, `rx` by `rz` about (x, z). */
export type Pond = { x: number; z: number; rx: number; rz: number };

export type GroundLook = {
  /** The lawn's greens: its body, its lighter patches, its flecks. */
  lawn: [string, string, string];
  /** Bare earth where the turf thins toward the bank. */
  dirt: string;
  /** The bank's stone, and the sand at its foot. */
  bank: string;
  sand?: string;
  /** The lake's bed where it is last seen. */
  bed?: string;
  /** Packed earth or gravel where a yard is kept bare. */
  yard?: string;
  /** Stones along the shore. */
  rocks: Palette;
};

/** Whose island it is: the page's own, roomy and planted in full, or a neighbour's, kept to its house and a few trees. */
export type IslandKind = 'home' | 'neighbour';

/**
 * An island's ground about its middle, at y = 0: the waterline runs round a rounded square `half` from the middle to a
 * straight side, its corners `corner` round, and wanders half a metre either way of it; the firm ground stops half a
 * metre inside it, and the bank under the water meets the lake's bed at most `reach` from the middle on a straight side.
 */
export type IslandShape = { half: number; corner: number; reach: number };

/**
 * How round an estate's corners are against its half: its coast runs round a squarish round (estate/coast, a
 * superellipse of power 2.5), whose diagonal a rounded square meets with corners this much of its half.
 */
const ESTATE_CORNER = 0.83;

/**
 * The page's own island is an estate (see estate/), four neighbours' islands across each way and as round at its
 * corners as the estate's coast; a neighbour's keeps to its house and a few trees.
 */
export const ISLANDS: Record<IslandKind, IslandShape> = {
  home: { half: HOME_HALF, corner: HOME_HALF * ESTATE_CORNER, reach: HOME_HALF + 1.9 },
  neighbour: { half: 5.5, corner: 2.6, reach: 7.4 },
};

/** The ground is cut in squares this many metres across: finer where it is looked at closely, coarser over an estate's breadth. */
export const GROUND_STEP: Record<IslandKind, number> = { home: 0.3, neighbour: 0.2 };

/**
 * How far from an island's middle its waterline lies at `bearing` (radians from +x toward +z), before it wanders: a
 * straight side's `half` square on, more toward a corner.
 */
export function shoreAt(shape: IslandShape, bearing: number): number {
  const a = Math.abs(Math.cos(bearing));
  const b = Math.abs(Math.sin(bearing));
  const flat = shape.half - shape.corner;
  const [near, far] = a > b ? [a, b] : [b, a];
  const side = shape.half / near;
  if (side * far <= flat) return side;
  // Past the straight side, on the corner's arc about (flat, flat).
  const mid = flat * (a + b);
  return mid + Math.sqrt(Math.max(0, mid * mid - 2 * flat * flat + shape.corner * shape.corner));
}

/** A small island's ground (the flag's) is cut as finely as the page's own once was: it is looked at as closely. */
const STEP = 0.14;

const smooth = (from: number, to: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/** Where an island's ground is, what may stand on it and where the lawn may grow. */
export class Site {
  private readonly kept: { x: number; z: number; rx: number; rz: number }[] = [];
  private readonly bared: { x: number; z: number; rx: number; rz: number }[] = [];

  constructor(
    readonly seed: number,
    readonly ponds: readonly Pond[] = [],
    readonly shape: IslandShape = ISLANDS.neighbour,
  ) {}

  /** How far inside the shoreline (x, z) lies, in metres; negative out in the lake. The line wanders, each island its own way. */
  shore(x: number, z: number): number {
    const { half, corner } = this.shape;
    const qx = Math.abs(x) - (half - corner);
    const qz = Math.abs(z) - (half - corner);
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - corner;
    const angle = Math.atan2(z, x);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const wander = (noise2(cos * 1.9 + this.seed * 3.7, sin * 1.9 + this.seed) - 0.5) * 0.7 + (noise2(cos * 5 + this.seed, sin * 5 - this.seed) - 0.5) * 0.24;
    return wander - outside;
  }

  /** How far into a pond (x, z) lies: 1 at its middle, 0 at its edge, less outside. */
  pond(x: number, z: number): number {
    let most = -9;
    for (const pond of this.ponds) most = Math.max(most, 1 - Math.hypot((x - pond.x) / pond.rx, (z - pond.z) / pond.rz));
    return most;
  }

  /** The ground's height at (x, z). */
  height(x: number, z: number): number {
    const inside = this.shore(x, z);
    const slope = smooth(-1.5, 0.5, inside);
    let height = -1.5 + 1.5 * slope;
    // The bank is broken ground: ledges and hollows, more of them the steeper it falls.
    if (slope > 0 && slope < 1) height += ((noise2(x * 1.6 + 31, z * 1.6 + 7) - 0.5) * 0.2 + (noise2(x * 5 + 3, z * 5 + 11) - 0.5) * 0.07) * (1 - Math.abs(slope * 2 - 1));
    const pond = this.pond(x, z);
    if (pond > -0.3) height = Math.min(height, -0.95 * smooth(-0.3, 0.45, pond));
    return height;
  }

  /** Keeps the lawn off the oval `rx` by `rz` about (x, z): a house stands there, or a path runs. */
  keep(x: number, z: number, rx: number, rz = rx): this {
    this.kept.push({ x, z, rx, rz });
    return this;
  }

  /** Keeps the oval `rx` by `rz` about (x, z) bare: a yard of packed earth, a court of gravel. Its edge is ragged. */
  bare(x: number, z: number, rx: number, rz = rx): this {
    this.bared.push({ x, z, rx, rz });
    return this;
  }

  /** How bare the ground at (x, z) is kept: 1 in a yard, 0 on the lawn. */
  bareness(x: number, z: number): number {
    let most = 0;
    const ragged = (noise2(x * 1.3 + this.seed, z * 1.3) - 0.5) * 0.3;
    for (const yard of this.bared) most = Math.max(most, smooth(1.08, 0.84, Math.hypot((x - yard.x) / yard.rx, (z - yard.z) / yard.rz) + ragged));
    return most;
  }

  /** Whether grass may grow at (x, z): on the flat, `margin` clear of the bank, off the ponds, the yards and whatever was kept. */
  open = (x: number, z: number, margin = 0.52): boolean => {
    if (this.shore(x, z) < margin || this.pond(x, z) > -0.34 || this.bareness(x, z) > 0.35) return false;
    for (const { x: kx, z: kz, rx, rz } of this.kept) if (Math.abs(x - kx) < rx && Math.abs(z - kz) < rz) return false;
    return true;
  };
}

type Corner = { x: number; z: number; height: number; normal: [number, number, number]; tint: [number, number, number] };

/** Adds the faces `pick` chooses, with only the corners they use. */
function faces(b: Builder, finish: Finish, corners: readonly (Corner | null)[], side: number, pick: (a: Corner, c: Corner, d: Corner, e: Corner) => boolean): void {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const tints: number[] = [];
  const indices: number[] = [];
  const slot = new Map<Corner, number>();
  const use = (corner: Corner) => {
    let index = slot.get(corner);
    if (index === undefined) {
      index = positions.length / 3;
      slot.set(corner, index);
      positions.push(corner.x, corner.height, corner.z);
      normals.push(...corner.normal);
      uvs.push(corner.x, corner.z);
      tints.push(...corner.tint);
    }
    return index;
  };
  for (let row = 0; row < side - 1; row++) {
    for (let column = 0; column < side - 1; column++) {
      const a = corners[row * side + column];
      const c = corners[row * side + column + 1];
      const d = corners[(row + 1) * side + column];
      const e = corners[(row + 1) * side + column + 1];
      if (!a || !c || !d || !e || !pick(a, c, d, e)) continue;
      indices.push(use(a), use(d), use(c), use(c), use(d), use(e));
    }
  }
  b.raw(finish, positions, normals, uvs, tints, indices);
}

/**
 * The ground of `site`, added to `b`: turf on the flat, broken stone and earth down the bank, sand and bed under the
 * water, cut in squares `step` metres across out to the site's reach.
 */
export function ground(b: Builder, site: Site, look: GroundLook, step = STEP): void {
  const { reach } = site.shape;
  const side = Math.round((reach * 2) / step) + 1;
  const heights = new Float32Array(side * side);
  const place = (index: number) => -reach + index * step;
  for (let row = 0; row < side; row++) for (let column = 0; column < side; column++) heights[row * side + column] = site.height(place(column), place(row));
  const at = (column: number, row: number) => heights[Math.min(side - 1, Math.max(0, row)) * side + Math.min(side - 1, Math.max(0, column))]!;

  const [lawnA, lawnB, lawnC] = look.lawn.map((hex) => new Color(hex)) as [Color, Color, Color];
  const dirt = new Color(look.dirt);
  const bank = new Color(look.bank);
  const sand = new Color(look.sand ?? '#c9b592');
  const bed = new Color(look.bed ?? '#1c3140');
  const yard = new Color(look.yard ?? look.dirt);
  const color = new Color();
  const corners: (Corner | null)[] = [];

  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const height = at(column, row);
      // Corners far under the water are not drawn: the deep hides them.
      if (height < -1.44 && at(column - 1, row) < -1.44 && at(column + 1, row) < -1.44 && at(column, row - 1) < -1.44 && at(column, row + 1) < -1.44) {
        corners.push(null);
        continue;
      }
      const x = place(column);
      const z = place(row);
      const dx = at(column - 1, row) - at(column + 1, row);
      const dz = at(column, row - 1) - at(column, row + 1);
      const length = Math.hypot(dx, 2 * step, dz);
      const grain = noise2(x * 2.4 + site.seed, z * 2.4);
      if (height > -0.03) {
        const patch = noise2(x * 0.5 + site.seed * 9, z * 0.5);
        color.copy(lawnA).lerp(lawnB, smooth(0.32, 0.72, patch)).lerp(lawnC, smooth(0.58, 0.9, grain) * 0.55);
        const thin = Math.max(smooth(0.8, 0.48, site.shore(x, z)), smooth(-0.5, -0.34, site.pond(x, z)));
        color.lerp(yard, site.bareness(x, z) * (0.86 + grain * 0.14)).lerp(dirt, thin * 0.85);
      } else if (height > WATER_LEVEL) {
        // Earth at the lip, stone below it, wet and dark where the water laps.
        const dry = (height - WATER_LEVEL) / -WATER_LEVEL;
        const stony = smooth(0.35, 0.65, noise2(x * 1.1 + site.seed * 5, z * 1.1 + 3));
        color.copy(dirt).lerp(bank, Math.max(stony, 1 - smooth(0.5, 0.95, dry))).multiplyScalar((0.55 + smooth(0, 0.4, dry) * 0.45) * (0.78 + grain * 0.44));
      } else {
        color.copy(sand).multiplyScalar(0.62).lerp(bed, smooth(0, 0.5, WATER_LEVEL - height));
      }
      corners.push({ x, z, height, normal: [dx / length, (2 * step) / length, dz / length], tint: [color.r, color.g, color.b] });
    }
  }
  const lawn = (a: Corner, c: Corner, d: Corner, e: Corner) => Math.min(a.height, c.height, d.height, e.height) > -0.035;
  // The ground takes shadows and throws none worth drawing.
  faces(b, { surface: 'ground', rough: 0.96, shadowless: true }, corners, side, lawn);
  faces(b, { surface: 'rock', rough: 0.94, shadowless: true }, corners, side, (a, c, d, e) => !lawn(a, c, d, e));
}

/** Where the waterline is, going out from the island's middle at `angle`. */
function waterline(site: Site, angle: number): [number, number] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let near = 2;
  let far = site.shape.reach + 1.6;
  for (let step = 0; step < 14; step++) {
    const middle = (near + far) / 2;
    if (site.height(cos * middle, sin * middle) > WATER_LEVEL) near = middle;
    else far = middle;
  }
  return [cos * near, sin * near];
}

/**
 * Stones down the island's bank and in its shallows, and reeds where the water is still. `clear` leaves a stretch
 * free: a landing, a bridge's foot. `share` thins the stones (and `reeds` counts the clumps of reeds) for an island
 * kept light; a longer shore has more of them. A clump of reeds is left out where `reedless` says, at its middle
 * (`clear`'s stretch, unless told otherwise): a clump spreads half a metre about it.
 */
export function dressShore(
  b: Builder,
  site: Site,
  look: GroundLook,
  clear: (x: number, z: number) => boolean = () => false,
  { share = 1, reeds: clumps = 7, reedless = clear }: { share?: number; reeds?: number; reedless?: (x: number, z: number) => boolean } = {},
): void {
  const { half, corner } = site.shape;
  const stones = Math.round((8 * (half - corner) + 2 * Math.PI * corner) * 3.8 * share);
  for (let index = 0; index < stones; index++) {
    const angle = (index / stones) * Math.PI * 2 + b.between(-0.03, 0.03);
    const [x, z] = waterline(site, angle);
    if (clear(x, z) || b.random() > b.density) continue;
    const big = b.random() < 0.12;
    const size = big ? b.between(0.5, 0.9) : b.between(0.14, 0.36);
    // Up the bank, at the water's edge, or just out in the shallows.
    const inland = big ? b.between(-0.1, 0.2) : b.between(-0.25, 0.5);
    const px = x - Math.cos(angle) * inland;
    const pz = z - Math.sin(angle) * inland;
    rock(b, [px, Math.max(site.height(px, pz), WATER_LEVEL - 0.08) - 0.03, pz], size, b.pick(look.rocks), b.between(0.55, 0.85));
  }
  for (let clump = 0; clump < clumps; clump++) {
    const angle = b.between(0, Math.PI * 2);
    const [x, z] = waterline(site, angle);
    if (reedless(x, z)) continue;
    reeds(b, [x + Math.cos(angle) * 0.15, WATER_LEVEL - 0.05, z + Math.sin(angle) * 0.15], 11, 0.5);
  }
}

/** Stones round a pond's edge. */
export function dressPond(b: Builder, pond: Pond, colors: Palette, clear: (x: number, z: number) => boolean = () => false): void {
  const stones = Math.round((pond.rx + pond.rz) * 9);
  for (let index = 0; index < stones; index++) {
    const angle = (index / stones) * Math.PI * 2 + b.between(-0.06, 0.06);
    const out = b.between(0.98, 1.12);
    const x = pond.x + Math.cos(angle) * pond.rx * out;
    const z = pond.z + Math.sin(angle) * pond.rz * out;
    if (clear(x, z) || b.random() < 0.15) continue;
    rock(b, [x, WATER_LEVEL + 0.02, z], b.random() < 0.2 ? b.between(0.45, 0.65) : b.between(0.2, 0.38), b.pick(colors), b.between(0.6, 0.85));
  }
}
