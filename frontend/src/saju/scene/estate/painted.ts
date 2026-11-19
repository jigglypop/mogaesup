import { Color } from 'three';

import type { TerrainCell } from '../../../api/types';
import { Builder, type Build } from '../build';
import { noise2 } from '../noise';
import type { GroundPaint } from './ground';
import type { EstateSite } from './site';

// The metres an owner painted, laid on the estate's own ground: each cell a square of the terrain's own surface, at the
// ground's height and bent with it, coloured as the estate's ground colours a whole lawn of that terrain (its patches
// and flecks, by where it lies). Square to square they meet with no seam; against the ground left as it was they end on
// the cell's edge, as a paving would.

/** Corners along each side of a cell, less one: enough to follow the ground where it bends, few for a whole lawn. */
const SPLIT = 2;
/** How far over the ground the paint lies: no flicker between the two, and nothing that reads as a raised tile. */
const LIFT = 0.012;
/** The step the ground's lean is read over, for the light. */
const LEAN = 0.25;

const smooth = (from: number, to: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/** The painted cells of an estate as one build, a mesh for each terrain; empty for none. */
export function paintedGround(site: EstateSite, cells: readonly TerrainCell[], paints: Readonly<Record<TerrainCell['terrain'], GroundPaint>>): Build {
  const b = new Builder(site.estate.seed);
  const seed = site.estate.seed % 1000;
  const color = new Color();
  for (const terrain of ['snow', 'desert', 'moss', 'gravel', 'soil'] as const) {
    const mine = cells.filter((cell) => cell.terrain === terrain);
    if (mine.length === 0) continue;
    const paint = paints[terrain];
    const [lawnA, lawnB, lawnC] = paint.lawn.map((hex) => new Color(hex)) as [Color, Color, Color];
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const tints: number[] = [];
    const faces: number[] = [];
    for (const cell of mine) {
      const base = positions.length / 3;
      for (let j = 0; j <= SPLIT; j++) {
        for (let i = 0; i <= SPLIT; i++) {
          const x = cell.x + i / SPLIT;
          const z = cell.z + j / SPLIT;
          const height = site.height(x, z);
          positions.push(x, height + LIFT, z);
          const dx = site.height(x - LEAN, z) - site.height(x + LEAN, z);
          const dz = site.height(x, z - LEAN) - site.height(x, z + LEAN);
          const length = Math.hypot(dx, 2 * LEAN, dz);
          normals.push(dx / length, (2 * LEAN) / length, dz / length);
          uvs.push(x, z);
          // As estate/ground paints a lawn: its body, lighter patches, flecks.
          const grain = noise2(x * 2.4 + seed, z * 2.4);
          const patch = noise2(x * 0.45 + seed * 9, z * 0.45);
          color.copy(lawnA).lerp(lawnB, smooth(0.32, 0.72, patch)).lerp(lawnC, smooth(0.58, 0.9, grain) * 0.55);
          tints.push(color.r, color.g, color.b);
        }
      }
      for (let j = 0; j < SPLIT; j++) {
        for (let i = 0; i < SPLIT; i++) {
          const a = base + j * (SPLIT + 1) + i;
          const c = a + 1;
          const d = a + SPLIT + 1;
          const e = d + 1;
          faces.push(a, d, c, c, d, e);
        }
      }
    }
    b.raw({ surface: paint.surface ?? 'ground', rough: 0.96, shadowless: true }, positions, normals, uvs, tints, faces);
  }
  return b.finish();
}
