// Numbers that look random and are the same every time: for the surfaces' textures, the ground's unevenness and where
// leaves, stones and flowers fall. Nothing here uses Math.random, so a home is drawn the same on every visit.

/** A lattice point's value, 0 to 1. */
export function hash(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);
const wrapped = (n: number, period: number) => ((n % period) + period) % period;

/** Smooth noise over a lattice that repeats every `period` cells each way; 0 to 1. */
export function tileNoise(x: number, y: number, period: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const x0 = wrapped(xi, period);
  const x1 = wrapped(xi + 1, period);
  const y0 = wrapped(yi, period);
  const y1 = wrapped(yi + 1, period);
  const a = hash(x0, y0, seed);
  const b = hash(x1, y0, seed);
  const c = hash(x0, y1, seed);
  const d = hash(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/**
 * Layers of {@link tileNoise} over the unit square, tiling at its edges: `cells` lattice cells across in the coarsest
 * of `octaves` layers, each finer layer half as strong. 0 to 1.
 */
export function fbm(u: number, v: number, cells: number, octaves: number, seed = 0): number {
  let sum = 0;
  let weight = 0;
  let strength = 1;
  let frequency = cells;
  for (let octave = 0; octave < octaves; octave++) {
    sum += strength * tileNoise(u * frequency, v * frequency, frequency, seed + octave * 17);
    weight += strength;
    strength *= 0.5;
    frequency *= 2;
  }
  return sum / weight;
}

/**
 * Cells about scattered points over the unit square, tiling at its edges, `cells` across: how far the nearest point
 * and the second nearest are (in cells), and a number of the nearest's own (0 to 1).
 */
export function worley(u: number, v: number, cells: number, seed = 0): { near: number; next: number; id: number } {
  const x = u * cells;
  const y = v * cells;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let near = 9;
  let next = 9;
  let id = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      const wx = wrapped(cx, cells);
      const wy = wrapped(cy, cells);
      const px = cx + 0.15 + hash(wx, wy, seed) * 0.7;
      const py = cy + 0.15 + hash(wx, wy, seed + 7) * 0.7;
      const distance = Math.hypot(px - x, py - y);
      if (distance < near) {
        next = near;
        near = distance;
        id = hash(wx, wy, seed + 13);
      } else if (distance < next) {
        next = distance;
      }
    }
  }
  return { near, next, id };
}

/** Smooth noise through space, not tiling; 0 to 1. For bending shapes: a rock's lumps, a shore's wander. */
export function noise3(x: number, y: number, z: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const w = fade(z - zi);
  const at = (dx: number, dy: number, dz: number) => hash(xi + dx + (zi + dz) * 57, yi + dy + (zi + dz) * 131, seed);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(lerp(at(0, 0, 0), at(1, 0, 0), u), lerp(at(0, 1, 0), at(1, 1, 0), u), v),
    lerp(lerp(at(0, 0, 1), at(1, 0, 1), u), lerp(at(0, 1, 1), at(1, 1, 1), u), v),
    w,
  );
}

/** Smooth noise over a plane, not tiling; 0 to 1. */
export const noise2 = (x: number, y: number, seed = 0) => noise3(x, y, 0, seed);

/** A stream of numbers 0 to 1 from `seed`, the same stream every time. */
export function rng(seed: number): () => number {
  let state = (seed * 2654435761) | 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
