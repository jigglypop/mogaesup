import { mulberry32 } from './spectrum';

// Two tiles the lake is painted with: ripples (their slopes, and their height) for a device that cannot compute the
// wave cascades, and the pattern foam breaks into. Painted off the main thread (see ../painter): this file is what the
// painter runs, and has nothing of the graphics card in it.

/** Texels a tile is across and down. */
export const SEA_TILE = 256;
const SIZE = SEA_TILE;
const WAVES = 110;

/** Ripples running mostly with the wind at `windAngle`: their slope east in red, south in green, their height in blue. */
export function detailData(windAngle: number, seed = 7): Uint8Array {
  const rand = mulberry32(seed);
  const fx = new Float32Array(WAVES);
  const fz = new Float32Array(WAVES);
  const amp = new Float32Array(WAVES);
  const phase = new Float32Array(WAVES);
  const wx = Math.cos(windAngle);
  const wz = Math.sin(windAngle);
  for (let i = 0; i < WAVES; i += 1) {
    let x = 0;
    let z = 0;
    while (x === 0 && z === 0) {
      const r = 1 + Math.floor(Math.pow(rand(), 1.6) * 22);
      const a = rand() * Math.PI * 2;
      x = Math.round(Math.cos(a) * r);
      z = Math.round(Math.sin(a) * r);
    }
    const len = Math.hypot(x, z);
    const align = Math.abs((x * wx + z * wz) / len);
    fx[i] = x;
    fz[i] = z;
    amp[i] = (0.35 + 0.65 * align * align) / Math.pow(len, 1.7);
    phase[i] = rand() * Math.PI * 2;
  }
  const sx = new Float32Array(SIZE * SIZE);
  const sz = new Float32Array(SIZE * SIZE);
  const h = new Float32Array(SIZE * SIZE);
  let maxSlope = 1e-6;
  let maxH = 1e-6;
  const twoPi = Math.PI * 2;
  // Each wave's phase is one part across and one part down: their sines and cosines are tabled once a row and once a
  // column, and every texel's are put together from them (the sine of a sum) instead of being worked out afresh.
  const acrossSin = new Float32Array(WAVES * SIZE);
  const acrossCos = new Float32Array(WAVES * SIZE);
  const downSin = new Float32Array(WAVES * SIZE);
  const downCos = new Float32Array(WAVES * SIZE);
  for (let i = 0; i < WAVES; i += 1) {
    for (let at = 0; at < SIZE; at += 1) {
      const across = twoPi * fx[i]! * (at / SIZE) + phase[i]!;
      const down = twoPi * fz[i]! * (at / SIZE);
      acrossSin[i * SIZE + at] = Math.sin(across);
      acrossCos[i * SIZE + at] = Math.cos(across);
      downSin[i * SIZE + at] = Math.sin(down);
      downCos[i * SIZE + at] = Math.cos(down);
    }
  }
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let hh = 0;
      let dx = 0;
      let dz = 0;
      for (let i = 0; i < WAVES; i += 1) {
        const su = acrossSin[i * SIZE + x]!;
        const cu = acrossCos[i * SIZE + x]!;
        const sv = downSin[i * SIZE + y]!;
        const cv = downCos[i * SIZE + y]!;
        const a = amp[i]!;
        hh += a * (su * cv + cu * sv);
        const c = a * twoPi * (cu * cv - su * sv);
        dx += c * fx[i]!;
        dz += c * fz[i]!;
      }
      const idx = y * SIZE + x;
      sx[idx] = dx;
      sz[idx] = dz;
      h[idx] = hh;
      maxSlope = Math.max(maxSlope, Math.abs(dx), Math.abs(dz));
      maxH = Math.max(maxH, Math.abs(hh));
    }
  }
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    data[i * 4] = Math.round((sx[i]! / maxSlope) * 127.5 + 127.5);
    data[i * 4 + 1] = Math.round((sz[i]! / maxSlope) * 127.5 + 127.5);
    data[i * 4 + 2] = Math.round((h[i]! / maxH) * 127.5 + 127.5);
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** A tileable value-noise lattice, sampled at any point of the unit square (wrapping). */
function lattice(cells: number, rand: () => number) {
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i += 1) grid[i] = rand();
  const g = (gx: number, gy: number) => grid[(((gy % cells) + cells) % cells) * cells + (((gx % cells) + cells) % cells)]!;
  return (x: number, y: number) => {
    const u = x * cells;
    const v = y * cells;
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const fx = u - x0;
    const fy = v - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * sx;
    const b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}

/**
 * The foam pattern: domain-warped noise with thin ridged veins, so foam breaks into torn streaks and lace rather than
 * cells. Red is the pattern; green, a second one unrelated to it, for the fields the lake's gusts and wave groups are
 * read from.
 */
export function foamData(seed = 11): Uint8Array {
  const rand = mulberry32(seed);
  const size = SIZE;
  const octaves = [4, 8, 16, 32, 64].map((c) => lattice(c, rand));
  const warpA = [3, 6, 12].map((c) => lattice(c, rand));
  const warpB = [3, 6, 12].map((c) => lattice(c, rand));
  const ridged = [6, 12, 24, 48].map((c) => lattice(c, rand));
  const broad = [2, 4, 8].map((c) => lattice(c, rand));
  const fbm = (fs: ((x: number, y: number) => number)[], x: number, y: number) => {
    let v = 0;
    let w = 0.5;
    let total = 0;
    for (const f of fs) {
      v += f(x, y) * w;
      total += w;
      w *= 0.5;
    }
    return v / total;
  };
  const raw = new Float32Array(size * size);
  const field = new Float32Array(size * size);
  let lo = Infinity;
  let hi = -Infinity;
  let fieldLo = Infinity;
  let fieldHi = -Infinity;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x / size;
      const py = y / size;
      const qx = px + (fbm(warpA, px, py) - 0.5) * 0.22;
      const qy = py + (fbm(warpB, px, py) - 0.5) * 0.22;
      const base = fbm(octaves, qx, qy);
      let vein = 0;
      let w = 0.5;
      for (const f of ridged) {
        const r = 1 - Math.abs(f(qx, qy) * 2 - 1);
        vein += r * r * r * w;
        w *= 0.5;
      }
      const v = base * 0.6 + vein * 0.55;
      raw[y * size + x] = v;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      const smooth = fbm(broad, px, py);
      field[y * size + x] = smooth;
      fieldLo = Math.min(fieldLo, smooth);
      fieldHi = Math.max(fieldHi, smooth);
    }
  }
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    data[i * 4] = data[i * 4 + 2] = Math.round(((raw[i]! - lo) / Math.max(1e-6, hi - lo)) * 255);
    data[i * 4 + 1] = Math.round(((field[i]! - fieldLo) / Math.max(1e-6, fieldHi - fieldLo)) * 255);
    data[i * 4 + 3] = 255;
  }
  return data;
}
