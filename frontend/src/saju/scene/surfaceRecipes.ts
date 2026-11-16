import { Color } from 'three';

import { fbm, hash, tileNoise, worley } from './noise';

// What things are made of, close up: each surface is a small tile of colour and of relief (how light catches its
// bumps), painted from noise. A tile repeats every `size` metres. Most only shade the colour a shape is given (plaster
// is plaster in any paint); brick and masonry bring their own colours. Painted off the main thread (see painter); this
// file is what the painter runs, and has nothing of the graphics card in it.

export type Surface = 'plain' | 'plaster' | 'brick' | 'masonry' | 'stone' | 'rock' | 'wood' | 'bark' | 'thatch' | 'gravel' | 'soil' | 'ground' | 'clay';

type Texel = { r: number; g: number; b: number; h: number };
type Recipe = {
  /** Metres one tile covers. */
  size: number;
  /** How deep the relief reads. */
  bump: number;
  /** The tile at (u, v), each 0 to 1 and tiling: a colour (as paint, 0 to 1) and a height (0 to 1). */
  paint: (u: number, v: number, out: Texel) => void;
};

/** Texels a tile is across and down. */
export const TILE = 256;
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const smooth = (from: number, to: number, value: number) => {
  const t = clamp((value - from) / (to - from));
  return t * t * (3 - 2 * t);
};
const fract = (value: number) => value - Math.floor(value);

/** A colour's paint values, 0 to 1 (as written in a hex code, not as light). */
function paintOf(hex: string): [number, number, number] {
  const color = new Color(hex).convertLinearToSRGB();
  return [color.r, color.g, color.b];
}
const shade = (out: Texel, value: number, h: number) => {
  out.r = out.g = out.b = value;
  out.h = h;
};
const tint = (out: Texel, from: [number, number, number], to: [number, number, number], t: number, gain: number) => {
  out.r = (from[0] + (to[0] - from[0]) * t) * gain;
  out.g = (from[1] + (to[1] - from[1]) * t) * gain;
  out.b = (from[2] + (to[2] - from[2]) * t) * gain;
};

const BRICK = { light: paintOf('#c4694a'), dark: paintOf('#9c452f'), burnt: paintOf('#6f3527'), mortar: paintOf('#cdbfae') };
const BLOCK = { light: paintOf('#e0d4bf'), dark: paintOf('#b6a68c'), grey: paintOf('#a9a49a'), mortar: paintOf('#8f8472') };

const RECIPES: Record<Exclude<Surface, 'plain'>, Recipe> = {
  /** 회벽: trowelled, with the faint blotches of weather. */
  plaster: {
    size: 1.6,
    bump: 1.1,
    paint: (u, v, out) => {
      const blotch = fbm(u, v, 3, 4, 1);
      const grain = fbm(u, v, 40, 2, 2);
      shade(out, 0.86 + blotch * 0.12 + (grain - 0.5) * 0.07, grain * 0.7 + blotch * 0.3);
      out.r += (blotch - 0.5) * 0.03;
    },
  },
  /** 붉은 벽돌 in running bond, each brick its own red, in pale mortar. */
  brick: {
    size: 1.2,
    bump: 2.6,
    paint: (u, v, out) => {
      const rows = 12;
      const columns = 4;
      const row = Math.floor(v * rows);
      const along = u * columns + (row % 2 ? 0.5 : 0);
      const column = Math.floor(along);
      const fx = along - column;
      const fy = v * rows - row;
      const edge = Math.min(Math.min(fx, 1 - fx) * 3.2, Math.min(fy, 1 - fy));
      const face = smooth(0.07, 0.2, edge);
      const id = hash(((column % columns) + columns) % columns, row, 5);
      const grit = fbm(u, v, 36, 2, 9);
      if (face < 0.5) {
        tint(out, BRICK.mortar, BRICK.mortar, 0, 0.86 + grit * 0.16);
      } else if (id > 0.86) {
        tint(out, BRICK.burnt, BRICK.dark, grit, 0.9 + grit * 0.15);
      } else {
        tint(out, BRICK.dark, BRICK.light, id / 0.86, 0.88 + grit * 0.18);
      }
      out.h = 0.25 + face * 0.55 + grit * 0.2;
    },
  },
  /** 석회석 blocks, roughly coursed: a chimney, a foundation, a garden wall. */
  masonry: {
    size: 1.3,
    bump: 2.8,
    paint: (u, v, out) => {
      const cell = worley(u, v * 1.0, 5, 21);
      const joint = smooth(0.03, 0.14, cell.next - cell.near);
      const grit = fbm(u, v, 30, 3, 4);
      if (joint < 0.4) tint(out, BLOCK.mortar, BLOCK.mortar, 0, 0.8 + grit * 0.2);
      else if (cell.id > 0.75) tint(out, BLOCK.grey, BLOCK.dark, grit, 0.86 + grit * 0.2);
      else tint(out, BLOCK.dark, BLOCK.light, cell.id / 0.75, 0.86 + grit * 0.2);
      out.h = joint * 0.7 + grit * 0.3;
    },
  },
  /** Dressed stone: a step, a lantern, a basin. Even, speckled. */
  stone: {
    size: 1.4,
    bump: 1.3,
    paint: (u, v, out) => {
      const cloud = fbm(u, v, 4, 4, 31);
      const speck = fbm(u, v, 64, 2, 33);
      shade(out, 0.8 + cloud * 0.16 + (speck > 0.66 ? -0.1 : speck < 0.3 ? 0.05 : 0), speck * 0.6 + cloud * 0.4);
    },
  },
  /** Boulders and banks: lumpy, cracked, darker in its hollows. */
  rock: {
    size: 2.2,
    bump: 3,
    paint: (u, v, out) => {
      const lump = fbm(u, v, 4, 5, 41);
      const crack = worley(u, v, 6, 43);
      const seam = smooth(0, 0.09, crack.next - crack.near);
      const value = 0.6 + lump * 0.42 - (1 - seam) * 0.2;
      shade(out, value, lump * 0.75 + seam * 0.25);
      out.g += (crack.id - 0.5) * 0.03;
      out.b -= lump * 0.03;
    },
  },
  /** Sawn boards, the grain running along u, a dark joint between one board and the next. */
  wood: {
    size: 1,
    bump: 1.8,
    paint: (u, v, out) => {
      const boards = 5;
      const board = Math.floor(v * boards);
      const fy = v * boards - board;
      const joint = smooth(0, 0.06, Math.min(fy, 1 - fy));
      const offset = hash(board, 3, 51);
      const grain = tileNoise(u * 4 + offset * 4, (v * boards + offset) * 22, 4, 53) * 0.6 + tileNoise(u * 8, v * boards * 46, 8, 55) * 0.4;
      const knot = smooth(0.82, 0.92, tileNoise(u * 4 + offset * 9, v * boards * 2, 4, 57));
      shade(out, (0.76 + grain * 0.24 + (hash(board, 7, 59) - 0.5) * 0.14 - knot * 0.25) * (0.55 + joint * 0.45), joint * 0.6 + grain * 0.4);
    },
  },
  /** A trunk's bark: furrows running up it (along v). */
  bark: {
    size: 0.9,
    bump: 3.2,
    paint: (u, v, out) => {
      const furrow = Math.abs(fbm(u, v * 0.3, 9, 3, 61) - 0.5) * 2;
      const fleck = fbm(u, v, 30, 2, 63);
      shade(out, 0.6 + furrow * 0.42 + (fleck - 0.5) * 0.12, furrow * 0.8 + fleck * 0.2);
    },
  },
  /** 초가: straw laid in courses, the strands running down (along v), each course shading the one under it. */
  thatch: {
    size: 1.3,
    bump: 2.4,
    paint: (u, v, out) => {
      const strand = tileNoise(u * 70, v * 5, 70, 71) * 0.6 + tileNoise(u * 140, v * 9, 140, 73) * 0.4;
      const course = fract(v * 4 + tileNoise(u * 9, 0, 9, 75) * 0.25);
      const lap = smooth(0, 0.3, course);
      shade(out, (0.66 + strand * 0.36) * (0.62 + lap * 0.38), lap * 0.6 + strand * 0.4);
      out.b -= 0.03;
    },
  },
  /** Pebbles: a path, a court. */
  gravel: {
    size: 1,
    bump: 2.6,
    paint: (u, v, out) => {
      const pebble = worley(u, v, 18, 81);
      const round = clamp(1 - pebble.near * 1.5);
      const value = (0.64 + pebble.id * 0.36) * (0.5 + smooth(0, 0.5, round) * 0.5);
      shade(out, value, round);
      out.r += (pebble.id - 0.5) * 0.05;
      out.b -= (pebble.id - 0.5) * 0.05;
    },
  },
  /** Turned earth. */
  soil: {
    size: 1.2,
    bump: 2.2,
    paint: (u, v, out) => {
      const clod = fbm(u, v, 14, 4, 91);
      const fine = fbm(u, v, 60, 2, 93);
      shade(out, 0.62 + clod * 0.34 + (fine - 0.5) * 0.12, clod * 0.7 + fine * 0.3);
    },
  },
  /** The island's own ground under grass, moss and sand alike: a fine nap. */
  ground: {
    size: 2.6,
    bump: 1.6,
    paint: (u, v, out) => {
      const nap = fbm(u, v, 26, 3, 101);
      const speck = fbm(u, v, 90, 2, 103);
      const patch = fbm(u, v, 5, 3, 105);
      shade(out, 0.74 + nap * 0.2 + (speck - 0.5) * 0.14 + (patch - 0.5) * 0.08, nap * 0.6 + speck * 0.4);
    },
  },
  /** Fired clay and glazed tile: even, with the kiln's small differences. */
  clay: {
    size: 0.9,
    bump: 0.9,
    paint: (u, v, out) => {
      const cloud = fbm(u, v, 6, 3, 111);
      const fine = fbm(u, v, 50, 2, 113);
      shade(out, 0.82 + cloud * 0.16 + (fine - 0.5) * 0.08, fine * 0.5 + cloud * 0.5);
    },
  },
};

/** Metres a tile of `surface` covers. */
export const surfaceSize = (surface: Exclude<Surface, 'plain'>): number => RECIPES[surface].size;

/** Every surface with a tile, most worn first: the order the painter paints them in. */
export const SURFACES: readonly Exclude<Surface, 'plain'>[] = ['ground', 'rock', 'wood', 'plaster', 'thatch', 'stone', 'soil', 'gravel', 'bark', 'clay', 'brick', 'masonry'];

/** A surface's colour tile (as paint, sRGB) and its relief as a normal map, each TILE square, four bytes a texel. */
export function paintSurface(surface: Exclude<Surface, 'plain'>): { colors: Uint8Array; normals: Uint8Array } {
  const recipe = RECIPES[surface];
  const colors = new Uint8Array(TILE * TILE * 4);
  const heights = new Float32Array(TILE * TILE);
  const texel: Texel = { r: 1, g: 1, b: 1, h: 0.5 };
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      recipe.paint((x + 0.5) / TILE, (y + 0.5) / TILE, texel);
      const at = y * TILE + x;
      heights[at] = texel.h;
      // A hollow is a little darker than the face around it: the shade the relief alone cannot draw.
      const hollow = 0.9 + clamp(texel.h) * 0.1;
      colors[at * 4] = Math.round(clamp(texel.r * hollow) * 255);
      colors[at * 4 + 1] = Math.round(clamp(texel.g * hollow) * 255);
      colors[at * 4 + 2] = Math.round(clamp(texel.b * hollow) * 255);
      colors[at * 4 + 3] = 255;
    }
  }
  const normals = new Uint8Array(TILE * TILE * 4);
  const heightAt = (x: number, y: number) => heights[((y + TILE) % TILE) * TILE + ((x + TILE) % TILE)]!;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const dx = (heightAt(x - 1, y) - heightAt(x + 1, y)) * recipe.bump;
      const dy = (heightAt(x, y - 1) - heightAt(x, y + 1)) * recipe.bump;
      const length = Math.hypot(dx, dy, 1);
      const at = (y * TILE + x) * 4;
      normals[at] = Math.round((dx / length) * 127.5 + 127.5);
      normals[at + 1] = Math.round((dy / length) * 127.5 + 127.5);
      normals[at + 2] = Math.round((1 / length) * 127.5 + 127.5);
      normals[at + 3] = 255;
    }
  }
  return { colors, normals };
}
