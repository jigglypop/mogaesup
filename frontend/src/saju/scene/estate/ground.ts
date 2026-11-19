import { Color } from 'three';

import type { Builder, Finish } from '../build';
import { WATER_LEVEL } from '../mood';
import { noise2 } from '../noise';
import type { EstateSite } from './site';

// An estate's ground as one mesh: turf on the flat, the yard and the paths trodden bare, sand on the beach, stone and
// earth down the bank, and the bed going on under the water until it is lost in the deep. It is a stand-in for the
// lawn builder's ground and reads the same site. Most of an estate is flat lawn, which a cell a metre across draws as
// well as a fine one: only where the ground bends or is painted (the bank, the beach, the stream, the ponds, the paths,
// the yard) is it cut a quarter of a metre fine. Where the two meet the ground is flat, so the finer cells' corners
// along the edge lie on the coarser one's and leave no crack.

/** The colours of an estate's ground. */
export type GroundPaint = {
  surface?: 'snow' | 'desert' | 'moss' | 'gravel' | 'soil';
  /** The lawn's body, its lighter patches, its flecks (the season's grass). */
  lawn: readonly [string, string, string];
  /** Bare earth where the turf thins toward the bank, the yard's packed earth and the paths' trodden earth. */
  dirt: string;
  yard: string;
  path: string;
  /** Stepping stones' ground: the stones themselves are laid on it. */
  stones: string;
  /** The bank's stone, the beach's dry sand, the bed under the water. */
  bank: string;
  sand: string;
  bed: string;
  /** What lies white over the lawn in winter, and how much of it (0 none). */
  cover: number;
};

/** A coarse cell's side and how many fine cells it is cut into across. */
const COARSE = 1;
const SPLIT = 4;
const FINE = COARSE / SPLIT;
/** Corners deeper than this under the water, with every neighbour as deep, are not drawn: the deep hides them. */
const LOST = -1.44;

const smooth = (from: number, to: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

type Corner = { height: number; tint: [number, number, number]; lawn: boolean };

/**
 * The ground's colour at (x, z) of height `height`, as light (linear, not paint), into `color`: what the ground mesh's
 * corners are painted.
 */
export function groundColor(site: EstateSite, paint: GroundPaint): (x: number, z: number, height: number, color: Color) => Color {
  const [lawnA, lawnB, lawnC] = paint.lawn.map((hex) => new Color(hex)) as [Color, Color, Color];
  const dirt = new Color(paint.dirt);
  const yard = new Color(paint.yard);
  const trodden = new Color(paint.path);
  const stony = new Color(paint.stones);
  const bank = new Color(paint.bank);
  const sand = new Color(paint.sand);
  const wetSand = new Color(paint.sand);
  const bed = new Color(paint.bed);
  const snow = new Color('#eef2f6');
  const seed = site.estate.seed % 1000;
  return (x, z, height, color) => {
    const grain = noise2(x * 2.4 + seed, z * 2.4);
    if (height > -0.03) {
      const patch = noise2(x * 0.45 + seed * 9, z * 0.45);
      color.copy(lawnA).lerp(lawnB, smooth(0.32, 0.72, patch)).lerp(lawnC, smooth(0.58, 0.9, grain) * 0.55);
      if (paint.cover > 0) color.lerp(snow, paint.cover * (0.78 + grain * 0.22));
      const thin = Math.max(smooth(0.8, 0.45, site.shore(x, z)), smooth(-0.5, -0.32, site.pond(x, z)));
      color.lerp(yard, site.bareness(x, z) * (0.86 + grain * 0.14)).lerp(dirt, thin * 0.85);
      const way = site.path(x, z);
      // A trodden way keeps some of its grass: worn, not dug.
      if (way.share > 0) color.lerp(way.stones ? stony : trodden, way.share * (way.stones ? 0.8 : 0.58) * (0.82 + grain * 0.18));
      const dry = site.sand(x, z);
      if (dry > 0) color.lerp(sand, dry * (0.9 + grain * 0.1));
    } else if (height > WATER_LEVEL) {
      // Earth at the lip, stone below it, wet and dark where the water laps; sand all the way down on the beach.
      const wet = (height - WATER_LEVEL) / -WATER_LEVEL;
      const stone = smooth(0.35, 0.65, noise2(x * 1.1 + seed * 5, z * 1.1 + 3));
      color.copy(dirt).lerp(bank, Math.max(stone, 1 - smooth(0.5, 0.95, wet))).multiplyScalar((0.55 + smooth(0, 0.4, wet) * 0.45) * (0.78 + grain * 0.44));
      const dry = site.sand(x, z);
      if (dry > 0) color.lerp(wetSand.copy(sand).multiplyScalar(0.8 + 0.2 * smooth(0, 0.6, wet)), Math.min(1, dry * 1.4));
    } else {
      color.copy(sand).multiplyScalar(0.62).lerp(bed, smooth(0, 0.5, WATER_LEVEL - height));
    }
    return color;
  };
}

/**
 * Adds the estate's ground to `b`, or with `strip` one of `of` strips of it running east to west, `index` 0 the
 * northernmost: each strip can be built on its own, in its own frame, and they meet without a crack (their corners on
 * the edge between them are the same corners). Returns how many corners and triangles it took.
 */
export function estateGround(b: Builder, site: EstateSite, paint: GroundPaint, strip: { index: number; of: number } = { index: 0, of: 1 }): { corners: number; triangles: number } {
  const reach = Math.ceil(site.estate.coast.groundReach / COARSE) * COARSE;
  const cells = Math.round((reach * 2) / COARSE);
  const fromRow = Math.floor((cells * strip.index) / strip.of);
  const toRow = Math.floor((cells * (strip.index + 1)) / strip.of);
  const lattice = cells * SPLIT + 1;
  const place = (index: number) => -reach + index * FINE;
  const paintAt = groundColor(site, paint);
  const color = new Color();

  const known = new Map<number, Corner>();
  const cornerAt = (i: number, j: number): Corner => {
    const key = j * lattice + i;
    let corner = known.get(key);
    if (corner) return corner;
    const x = place(i);
    const z = place(j);
    const height = site.height(x, z);
    paintAt(x, z, height, color);
    corner = { height, tint: [color.r, color.g, color.b], lawn: height > -0.035 };
    known.set(key, corner);
    return corner;
  };

  /** Whether a coarse cell must be cut fine: anything that bends the ground or paints it lies within reach of it. */
  const fineCell = (ci: number, cj: number): boolean => {
    const x = place(ci * SPLIT) + COARSE / 2;
    const z = place(cj * SPLIT) + COARSE / 2;
    const inside = site.shore(x, z);
    const { lawn } = site.estate.coast.bank(Math.atan2(z, x));
    if (inside < lawn + 2.2) return true;
    if (site.pond(x, z) > -3) return true;
    if (site.bareness(x, z) > 0.01 || site.bareness(x + 0.9, z) > 0.01 || site.bareness(x - 0.9, z) > 0.01 || site.bareness(x, z + 0.9) > 0.01 || site.bareness(x, z - 0.9) > 0.01) return true;
    for (const [dx, dz] of [[0, 0], [0.9, 0], [-0.9, 0], [0, 0.9], [0, -0.9]] as const) if (site.path(x + dx, z + dz).share > 0) return true;
    return false;
  };

  /** One pile's corners and faces: each pile keeps only the corners its own faces use. */
  type Pack = { positions: number[]; normals: number[]; uvs: number[]; tints: number[]; faces: number[]; slot: Map<number, number> };
  const pack = (): Pack => ({ positions: [], normals: [], uvs: [], tints: [], faces: [], slot: new Map() });
  const turf = pack();
  const banks = pack();
  /** The normal at a corner from the heights `step` fine cells to either side: what the light reads the ground's lean by. */
  const normalAt = (i: number, j: number, step: number): [number, number, number] => {
    const here = cornerAt(i, j).height;
    const left = i - step >= 0 ? cornerAt(i - step, j).height : here;
    const right = i + step < lattice ? cornerAt(i + step, j).height : here;
    const up = j - step >= 0 ? cornerAt(i, j - step).height : here;
    const down = j + step < lattice ? cornerAt(i, j + step).height : here;
    const dx = left - right;
    const dz = up - down;
    const run = 2 * step * FINE;
    const length = Math.hypot(dx, run, dz);
    return [dx / length, run / length, dz / length];
  };
  const use = (into: Pack, i: number, j: number, step: number): number => {
    const key = j * lattice + i;
    let index = into.slot.get(key);
    if (index !== undefined) return index;
    const corner = cornerAt(i, j);
    index = into.positions.length / 3;
    into.slot.set(key, index);
    const x = place(i);
    const z = place(j);
    into.positions.push(x, corner.height, z);
    into.normals.push(...normalAt(i, j, step));
    into.uvs.push(x, z);
    into.tints.push(...corner.tint);
    return index;
  };
  const quad = (i0: number, j0: number, size: number) => {
    const a = cornerAt(i0, j0);
    const c = cornerAt(i0 + size, j0);
    const d = cornerAt(i0, j0 + size);
    const e = cornerAt(i0 + size, j0 + size);
    if (Math.max(a.height, c.height, d.height, e.height) < LOST) return;
    const into = a.lawn && c.lawn && d.lawn && e.lawn ? turf : banks;
    const step = size === SPLIT ? SPLIT : 1;
    const ia = use(into, i0, j0, step);
    const ic = use(into, i0 + size, j0, step);
    const id = use(into, i0, j0 + size, step);
    const ie = use(into, i0 + size, j0 + size, step);
    into.faces.push(ia, id, ic, ic, id, ie);
  };
  for (let cj = fromRow; cj < toRow; cj++) {
    for (let ci = 0; ci < cells; ci++) {
      // Far out under the water, where even the fine bank has long gone down into the deep: nothing to draw.
      const x = place(ci * SPLIT) + COARSE / 2;
      const z = place(cj * SPLIT) + COARSE / 2;
      if (site.shore(x, z) < -site.estate.coast.bank(Math.atan2(z, x)).bed - 1.5) continue;
      if (!fineCell(ci, cj)) {
        quad(ci * SPLIT, cj * SPLIT, SPLIT);
        continue;
      }
      for (let fj = 0; fj < SPLIT; fj++) for (let fi = 0; fi < SPLIT; fi++) quad(ci * SPLIT + fi, cj * SPLIT + fj, 1);
    }
  }
  // The ground takes shadows and throws none worth drawing.
  const lawnFinish: Finish = { surface: paint.surface ?? 'ground', rough: 0.96, shadowless: true };
  const bankFinish: Finish = { surface: 'rock', rough: 0.94, shadowless: true };
  for (const [into, finish] of [[turf, lawnFinish], [banks, bankFinish]] as const) b.raw(finish, into.positions, into.normals, into.uvs, into.tints, into.faces);
  return { corners: (turf.positions.length + banks.positions.length) / 3, triangles: (turf.faces.length + banks.faces.length) / 3 };
}
