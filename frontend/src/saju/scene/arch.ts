import type { Builder, Finish, PaneStyle, V3 } from './build';
import { rock, toned, type Palette } from './plants';

// What is built: roofs laid tile by tile, windows with a lit room behind them, doors, chimneys, steps, railings,
// lanterns, walls and the furniture of a yard. Everything is drawn about its own foot, facing +z, and turned into
// place by the caller.

const QUARTER = Math.PI / 2;
const TAU = Math.PI * 2;

/** What a roof is covered with. */
export type Cover =
  /** Half-round tiles in rows down the slope: 스페인 기와 in clay, 기와 in grey, 청기와 glazed. */
  | { kind: 'barrel'; tiles: Palette; pan: string; rough?: number; lift?: number; caps?: string; pitch?: number }
  /** Split wooden shakes, no two the same width. */
  | { kind: 'shingle'; shingles: Palette }
  | { kind: 'plain'; color: string };

/**
 * One slope of a roof, in its own place: the ridge along x at height `rise` over z = 0, the eave at z = `run` and
 * y = 0, `width` along the ridge.
 */
export function slope(b: Builder, width: number, run: number, rise: number, cover: Cover): void {
  const length = Math.hypot(run, rise);
  const pitch = Math.atan2(rise, run);
  const sin = Math.sin(pitch);
  const cos = Math.cos(pitch);
  const deck = cover.kind === 'barrel' ? cover.pan : cover.kind === 'shingle' ? toned(cover.shingles[0]!, 0.5) : cover.color;
  b.box([width, 0.08, length], [0, rise / 2, run / 2], deck, { surface: 'clay', rough: 0.9 }, [pitch, 0, 0]);
  /** A point `along` metres down the slope from the ridge, `proud` of the deck. */
  const on = (x: number, along: number, proud: number): V3 => [x, rise - along * sin + proud * cos, along * cos + proud * sin];
  if (cover.kind === 'barrel') {
    const columns = Math.max(2, Math.round(width / (cover.pitch ?? 0.25)));
    const step = width / columns;
    const rows = Math.max(2, Math.ceil(length / 0.36));
    const each = length / rows;
    const radius = step * 0.36;
    for (let column = 0; column < columns; column++) {
      const x = -width / 2 + step * (column + 0.5);
      // 처마 곡선: a 기와 roof's eaves rise toward its corners.
      const corner = cover.lift ? cover.lift * Math.abs(x / (width / 2)) ** 3 : 0;
      for (let row = 0; row < rows; row++) {
        const along = (row + 0.5) * each;
        const at = on(x, along, 0.05 + radius * 0.3);
        at[1] += corner * (along / length) ** 2;
        b.cyl(radius, each * 1.2, at, b.pick(cover.tiles), { top: radius * 0.8, sides: 8, surface: 'clay', rough: cover.rough ?? 0.8, vary: 0.13 }, [pitch - QUARTER + 0.05, 0, 0]);
      }
      if (cover.caps) {
        const end = on(x, length + 0.01, 0.05 + radius * 0.3);
        end[1] += corner;
        b.cyl(radius * 1.12, 0.035, end, cover.caps, { sides: 10, surface: 'clay', rough: cover.rough ?? 0.8 }, [pitch - QUARTER, 0, 0]);
      }
    }
  } else if (cover.kind === 'shingle') {
    const rows = Math.max(2, Math.ceil(length / 0.27));
    const each = length / rows;
    for (let row = 0; row < rows; row++) {
      let x = -width / 2 - b.between(0, 0.15);
      while (x < width / 2) {
        const wide = b.between(0.2, 0.36);
        const middle = Math.min(width / 2 - 0.02, x + wide / 2);
        const reach = each * b.between(1.3, 1.5);
        b.box([wide - 0.014, 0.034, reach], on(middle, (row + 0.5) * each + b.between(-0.02, 0.02), 0.06 + (row % 2) * 0.004), b.pick(cover.shingles), { surface: 'wood', rough: 0.92, vary: 0.16 }, [pitch - 0.1, 0, 0]);
        x += wide;
      }
    }
  }
}

export type RoofLook = {
  /** The walls it covers: along the ridge (x), and across (z). */
  width: number;
  depth: number;
  /** The ridge's height above the top of the walls. */
  rise: number;
  /** How far the eaves hang out past the walls, and the roof past its gable ends. */
  over?: number;
  verge?: number;
  cover: Cover;
  /** The gables' walls. */
  wall: string;
  wallFinish?: Finish;
  /** Bargeboards, fascia and rafters' ends. */
  trim: string;
  /** The ridge's own cap, when it differs from the tiles. */
  ridge?: string;
  /** Cover the slope facing away as well (nobody sees it; it only costs). */
  both?: boolean;
};

/**
 * A gable roof standing on walls whose top is at `at` (the middle of the top of the walls). Its ridge runs along x;
 * `turn` it a quarter for a wing that runs the other way.
 */
export function gableRoof(b: Builder, at: V3, look: RoofLook, turn = 0): void {
  const { width, depth, rise, over = 0.34, verge = 0.2, cover, trim } = look;
  const run = depth / 2 + over;
  const full = (rise * run) / (depth / 2);
  const drop = full - rise;
  const pitch = Math.atan2(full, run);
  const length = Math.hypot(run, full);
  const ridgeColor = look.ridge ?? (cover.kind === 'barrel' ? cover.tiles[0]! : cover.kind === 'shingle' ? cover.shingles[0]! : cover.color);
  b.group(
    at,
    () => {
      b.prism([width, rise, depth], [0, 0, 0], look.wall, look.wallFinish ?? { surface: 'plaster' });
      b.group([0, -drop, 0], () => slope(b, width + verge * 2, run, full, cover));
      b.group([0, -drop, 0], () => slope(b, width + verge * 2, run, full, look.both ? cover : { kind: 'plain', color: cover.kind === 'barrel' ? cover.pan : ridgeColor }), Math.PI);
      // The ridge: a row of tiles laid along it.
      const pieces = Math.max(2, Math.round((width + verge * 2) / 0.4));
      const each = (width + verge * 2) / pieces;
      for (let piece = 0; piece < pieces; piece++) {
        b.cyl(cover.kind === 'shingle' ? 0.07 : 0.1, each * 1.08, [-width / 2 - verge + each * (piece + 0.5), rise + 0.07, 0], ridgeColor, { sides: 8, surface: cover.kind === 'shingle' ? 'wood' : 'clay', rough: 0.85, vary: 0.1 }, [0, 0, QUARTER]);
      }
      for (const end of [-1, 1]) {
        for (const side of [1, -1]) {
          b.box([0.05, 0.15, length + 0.04], [end * (width / 2 + verge - 0.02), rise / 2 - drop / 2 - 0.08, (side * run) / 2], trim, { surface: 'wood', rough: 0.8 }, [side * pitch, 0, 0]);
        }
      }
      b.box([width + verge * 2, 0.1, 0.04], [0, -drop - 0.03, run + 0.01], trim, { surface: 'wood', rough: 0.8 });
      const tails = Math.max(2, Math.round(width / 0.5));
      for (let tail = 0; tail <= tails; tail++) {
        b.box([0.06, 0.09, over + 0.1], [-width / 2 + (width * tail) / tails, -drop * 0.5 - 0.06, depth / 2 + over / 2], trim, { surface: 'wood', rough: 0.8 }, [pitch, 0, 0]);
      }
    },
    turn,
  );
}

export type WindowLook = {
  size: [number, number];
  frame: string;
  /** What is behind the glass, and how brightly it is lit. */
  style?: PaneStyle;
  power?: number;
  /** Panes across and up. */
  bars?: [number, number];
  sill?: string;
  shutters?: string;
  /** A round head over it. */
  arch?: boolean;
  /** A box of flowers under it, in these colours. */
  flowers?: Palette;
};

/** A window whose middle is at `at` on a wall facing +z. */
export function windowAt(b: Builder, at: V3, look: WindowLook, turn = 0): void {
  const { size: [wide, tall], frame, style = 'room', power = 2.6, bars = [2, 2], sill, shutters, arch, flowers } = look;
  const rim = 0.045;
  const wood: Finish = { surface: 'wood', rough: 0.7 };
  b.group(
    at,
    () => {
      b.pane([wide, tall], [0, 0, 0.014], style, power);
      b.box([wide + rim * 2, rim, 0.07], [0, -tall / 2 - rim / 2, 0.02], frame, wood);
      if (!arch) b.box([wide + rim * 2, rim, 0.07], [0, tall / 2 + rim / 2, 0.02], frame, wood);
      for (const side of [-1, 1]) b.box([rim, tall, 0.07], [side * (wide / 2 + rim / 2), 0, 0.02], frame, wood);
      for (let bar = 1; bar < bars[0]; bar++) b.box([0.02, tall, 0.03], [-wide / 2 + (wide * bar) / bars[0], 0, 0.022], frame, wood);
      for (let bar = 1; bar < bars[1]; bar++) b.box([wide, 0.02, 0.03], [0, -tall / 2 + (tall * bar) / bars[1], 0.022], frame, wood);
      if (arch) {
        b.cyl(wide / 2, 0.012, [0, tall / 2, 0.012], '#ffe2a6', { sides: 24, glow: '#ffd08a', power: power * 0.85 }, [QUARTER, 0, 0]);
        b.ring(wide / 2 + rim / 2, rim / 2, [0, tall / 2, 0.03], frame, { arc: Math.PI, rough: 0.7 });
        b.box([0.02, wide / 2, 0.03], [0, tall / 2 + wide / 4, 0.024], frame, wood);
      }
      if (sill) b.box([wide + 0.2, 0.04, 0.12], [0, -tall / 2 - rim - 0.02, 0.05], sill, { surface: 'stone', rough: 0.8 });
      if (shutters) {
        for (const side of [-1, 1]) {
          const x = side * (wide / 2 + rim + wide * 0.22 + 0.012);
          b.box([wide * 0.44, tall + 0.05, 0.026], [x, 0, 0.016], shutters, wood);
          for (let slat = 0; slat < 5; slat++) b.box([wide * 0.34, 0.012, 0.012], [x, -tall * 0.38 + slat * tall * 0.19, 0.034], toned(shutters, 0.7), wood);
        }
      }
      if (flowers) {
        const y = -tall / 2 - rim - 0.1;
        b.box([wide + 0.12, 0.11, 0.13], [0, y, 0.1], '#6b4a35', wood);
        const heads = Math.round((wide + 0.1) / 0.06);
        for (let head = 0; head < heads; head++) {
          const x = -wide / 2 - 0.05 + (head / (heads - 1)) * (wide + 0.1);
          b.sprig('leaf', [x, y + 0.08, 0.1 + b.between(-0.03, 0.05)], b.between(0.14, 0.2), b.pick(['#4f8a45', '#5f9a50']), [0, 1, 0.4], b.between(0, TAU), [0, 0.7, 0.7], b.between(0.8, 1));
          b.sprig('bloom', [x + b.between(-0.02, 0.02), y + b.between(0.1, 0.19), 0.13 + b.between(-0.02, 0.05)], b.between(0.07, 0.1), b.pick(flowers), [0, 0.8, 0.6], b.between(0, TAU));
          if (head % 3 === 0) b.sprig('leaf', [x, y - b.between(0, 0.1), 0.18], 0.15, '#4f8a45', [0, -0.6, 0.8], b.between(0, TAU), [0, 0.3, 1], 0.85);
        }
      }
    },
    turn,
  );
}

export type DoorLook = { size: [number, number]; color: string; frame: string; knob?: string; /** A lit light over the door. */ transom?: boolean; /** Two leaves. */ double?: boolean };

/** A door standing on `at` in a wall facing +z. */
export function doorAt(b: Builder, at: V3, look: DoorLook, turn = 0): void {
  const { size: [wide, tall], color, frame, knob = '#d9b25c', transom, double } = look;
  const wood: Finish = { surface: 'wood', rough: 0.62 };
  b.group(
    at,
    () => {
      const head = transom ? 0.17 : 0;
      for (const side of [-1, 1]) b.box([0.06, tall + head + 0.06, 0.08], [side * (wide / 2 + 0.03), (tall + head + 0.06) / 2, 0.02], frame, wood);
      b.box([wide + 0.16, 0.07, 0.1], [0, tall + head + 0.06, 0.025], frame, wood);
      if (transom) {
        b.pane([wide, head - 0.03], [0, tall + head / 2 + 0.01, 0.014], 'lantern', 2.4);
        b.box([wide, 0.03, 0.06], [0, tall + 0.005, 0.02], frame, wood);
      }
      const leaves = double ? 2 : 1;
      const each = wide / leaves;
      for (let leaf = 0; leaf < leaves; leaf++) {
        const x = -wide / 2 + each * (leaf + 0.5);
        b.box([each - 0.012, tall, 0.045], [x, tall / 2, 0.012], color, wood);
        for (const [y, height] of [[0.74, 0.32], [0.3, 0.4]] as const) {
          b.box([each - 0.13, tall * height, 0.012], [x, tall * y, 0.04], toned(color, 0.82), wood);
          b.box([each - 0.19, tall * height - 0.06, 0.012], [x, tall * y, 0.046], toned(color, 1.08), wood);
        }
      }
      const pull = double ? 0.05 : wide / 2 - 0.08;
      b.ball(0.022, [pull, tall * 0.48, 0.07], knob, { metal: 0.8, rough: 0.3, detail: 8 });
      if (double) b.ball(0.022, [-pull, tall * 0.48, 0.07], knob, { metal: 0.8, rough: 0.3, detail: 8 });
    },
    turn,
  );
}

/** A chimney standing on `at`, `size` across and `height` tall; its smoke is left to the caller. */
export function chimney(b: Builder, at: V3, size: [number, number], height: number, look: { color?: string; surface?: 'masonry' | 'brick' | 'plaster'; cap?: string } = {}): void {
  const { color = '#ffffff', surface = 'masonry', cap = '#cfc6b6' } = look;
  b.box([size[0], height, size[1]], [at[0], at[1] + height / 2, at[2]], color, { surface });
  b.box([size[0] + 0.1, 0.07, size[1] + 0.1], [at[0], at[1] + height + 0.035, at[2]], cap, { surface: 'stone' });
  b.box([size[0] - 0.08, 0.1, size[1] - 0.08], [at[0], at[1] + height + 0.12, at[2]], '#3a3532', { rough: 0.9 });
  b.box([size[0] + 0.02, 0.03, size[1] + 0.02], [at[0], at[1] + height + 0.2, at[2]], '#2e2b2a', { rough: 0.7, metal: 0.5 });
}

/** Steps `width` wide climbing away from the viewer (toward -z) from `at`, their front foot. */
export function steps(b: Builder, at: V3, width: number, count: number, look: { rise?: number; tread?: number; color?: string; surface?: 'stone' | 'masonry' | 'wood' } = {}, turn = 0): void {
  const { rise = 0.09, tread = 0.2, color = '#d5ccbc', surface = 'stone' } = look;
  b.group(
    at,
    () => {
      for (let step = 0; step < count; step++) {
        const long = tread * (count - step);
        b.box([width, rise, long], [0, rise * (step + 0.5), -tread * step - long / 2], color, { surface, rough: 0.85, vary: 0.04 });
      }
    },
    turn,
  );
}

export type RailLook = { height?: number; color: string; every?: number; metal?: number; rough?: number; thick?: number };

/** A railing from one point to another: posts at its ends, a rail along the top and balusters between. */
export function railing(b: Builder, from: V3, to: V3, look: RailLook): void {
  const { height = 0.42, color, every = 0.1, metal = 0.6, rough = 0.5, thick = 0.016 } = look;
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const length = Math.hypot(dx, dz);
  const finish: Finish = { metal, rough };
  b.group(
    from,
    () => {
      b.box([length, thick * 1.8, thick * 1.8], [length / 2, height, 0], color, finish);
      b.box([length, thick, thick], [length / 2, 0.05, 0], color, finish);
      const count = Math.max(1, Math.round(length / every));
      for (let index = 1; index < count; index++) b.box([thick, height - 0.05, thick], [(length * index) / count, height / 2 + 0.02, 0], color, finish);
      for (const end of [0, length]) b.box([thick * 2.6, height + 0.05, thick * 2.6], [end, (height + 0.05) / 2, 0], color, finish);
    },
    [0, Math.atan2(-dz, dx), 0],
  );
}

export type LanternLook = {
  /** `path` a low garden light, `post` a lamp on a tall post, `wall` a bracket lamp, `stone` a 석등, `paper` a paper lantern hung at `at`. */
  kind: 'path' | 'post' | 'wall' | 'stone' | 'paper';
  light?: string;
  frame?: string;
  power?: number;
  height?: number;
};

/** A lit lantern standing on (or hung at) `at`. It lights what is near it. */
export function lantern(b: Builder, at: V3, look: LanternLook, turn = 0): void {
  const { kind, light = '#ffc87e', frame = '#2c2a2b', power = 1 } = look;
  const iron: Finish = { metal: 0.7, rough: 0.5 };
  const cage = (y: number, wide: number, tall: number) => {
    b.box([wide * 0.72, tall, wide * 0.72], [0, y + tall / 2, 0], '#ffe9bd', { glow: light, power: 5 * power });
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) b.box([0.014, tall + 0.02, 0.014], [(x * wide) / 2, y + tall / 2, (z * wide) / 2], frame, iron);
    b.box([wide + 0.03, 0.016, wide + 0.03], [0, y, 0], frame, iron);
    b.cone(wide * 0.95, wide * 0.55, [0, y + tall + wide * 0.27, 0], frame, { ...iron, sides: 4 }, Math.PI / 4);
    b.ball(0.014, [0, y + tall + wide * 0.56, 0], frame, { ...iron, detail: 6 });
  };
  b.group(
    at,
    () => {
      if (kind === 'path') {
        const tall = look.height ?? 0.34;
        b.cyl(0.05, 0.03, [0, 0.015, 0], frame, { ...iron, sides: 8 });
        b.cyl(0.016, tall, [0, tall / 2, 0], frame, { ...iron, sides: 6 });
        cage(tall, 0.12, 0.15);
        b.lamp([0, tall + 0.1, 0], light, 1.5 * power, 3.2);
      } else if (kind === 'post') {
        const tall = look.height ?? 1.25;
        b.cyl(0.07, 0.06, [0, 0.03, 0], frame, { ...iron, sides: 8 });
        b.cyl(0.024, tall, [0, tall / 2, 0], frame, { ...iron, sides: 8 });
        b.box([0.16, 0.014, 0.014], [0, tall * 0.86, 0], frame, iron);
        cage(tall, 0.16, 0.2);
        b.lamp([0, tall + 0.12, 0], light, 2.6 * power, 5);
      } else if (kind === 'wall') {
        b.box([0.03, 0.12, 0.02], [0, 0.02, 0.01], frame, iron);
        b.box([0.014, 0.014, 0.12], [0, 0.07, 0.06], frame, iron);
        b.group([0, -0.08, 0.12], () => cage(0, 0.1, 0.13));
        b.lamp([0, 0, 0.2], light, 1.4 * power, 3);
      } else if (kind === 'stone') {
        const stone: Finish = { surface: 'stone', rough: 0.9 };
        const grey = '#c9c2b4';
        b.cyl(0.19, 0.09, [0, 0.045, 0], grey, { ...stone, top: 0.15, sides: 8 });
        b.cyl(0.06, 0.4, [0, 0.29, 0], grey, { ...stone, sides: 8 });
        b.cyl(0.13, 0.06, [0, 0.52, 0], grey, { ...stone, top: 0.17, sides: 8 });
        b.box([0.15, 0.17, 0.15], [0, 0.635, 0], '#ffe9bd', { glow: light, power: 4.5 * power });
        for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) b.box([0.04, 0.18, 0.04], [x * 0.085, 0.64, z * 0.085], grey, stone);
        b.cone(0.27, 0.16, [0, 0.8, 0], grey, { ...stone, sides: 4 }, Math.PI / 4);
        b.ball(0.045, [0, 0.9, 0], grey, { ...stone, detail: 8 });
        b.lamp([0, 0.66, 0], light, 1.8 * power, 3.6);
      } else {
        b.cyl(0.004, 0.16, [0, 0.14, 0], '#3a3331', { sides: 4 });
        b.ball(0.085, [0, 0, 0], '#ffd9a0', { scale: [1, 1.15, 1], glow: light, power: 4.2 * power, detail: 12 });
        b.cyl(0.04, 0.016, [0, 0.098, 0], frame, { sides: 8 });
        b.cyl(0.04, 0.016, [0, -0.098, 0], frame, { sides: 8 });
        b.lamp([0, -0.05, 0], light, 1.3 * power, 3);
      }
    },
    turn,
  );
}

/** A fence from one point on the ground to another: `picket`s, `rail`s between posts, or split `bamboo`. */
export function fence(b: Builder, from: [number, number], to: [number, number], look: { kind: 'picket' | 'rail' | 'bamboo'; height?: number; color: string }): void {
  const { kind, height = 0.42, color } = look;
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const length = Math.hypot(dx, dz);
  const wood: Finish = { surface: 'wood', rough: 0.85, vary: 0.1 };
  b.group(
    [from[0], 0, from[1]],
    () => {
      if (kind === 'rail') {
        const posts = Math.max(2, Math.round(length / 0.8) + 1);
        for (let post = 0; post < posts; post++) b.box([0.06, height + 0.06, 0.06], [(length * post) / (posts - 1), (height + 0.06) / 2, 0], color, wood, [0, b.between(-0.1, 0.1), b.between(-0.04, 0.04)]);
        for (const y of [0.42, 0.82]) b.box([length, 0.045, 0.03], [length / 2, height * y, 0], color, wood);
      } else {
        const count = Math.max(2, Math.round(length / (kind === 'bamboo' ? 0.055 : 0.1)));
        for (let index = 0; index <= count; index++) {
          const tall = height * b.between(0.94, 1.04);
          if (kind === 'bamboo') b.cyl(0.02, tall, [(length * index) / count, tall / 2, 0], color, { rough: 0.5, sides: 6, vary: 0.14 });
          else b.box([0.06, tall, 0.018], [(length * index) / count, tall / 2, 0], color, wood);
        }
        for (const y of [0.3, 0.78]) b.box([length, 0.035, 0.03], [length / 2, height * y, -0.02], toned(color, 0.8), wood);
      }
    },
    [0, Math.atan2(-dz, dx), 0],
  );
}

/** 돌담: stones stacked dry in courses from one point on the ground to another, a cap of tiles over them when `cap` is given. */
export function stoneWall(b: Builder, from: [number, number], to: [number, number], height: number, colors: Palette, cap?: string): void {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const courses = Math.max(1, Math.round(height / 0.19));
  const across = Math.max(2, Math.round(length / 0.3));
  for (let course = 0; course < courses; course++) {
    for (let index = 0; index < across; index++) {
      const t = (index + (course % 2 ? 0.5 : 0) + b.between(-0.15, 0.15)) / across;
      if (t < 0 || t > 1) continue;
      rock(b, [from[0] + (to[0] - from[0]) * t + b.between(-0.03, 0.03), course * (height / courses), from[1] + (to[1] - from[1]) * t + b.between(-0.03, 0.03)], b.between(0.3, 0.4), b.pick(colors), 0.72);
    }
  }
  if (cap) {
    const turn = Math.atan2(-(to[1] - from[1]), to[0] - from[0]);
    b.group(
      [(from[0] + to[0]) / 2, height + 0.04, (from[1] + to[1]) / 2],
      () => {
        b.prism([length, 0.14, 0.44], [0, 0, 0], cap, { surface: 'clay', rough: 0.8 });
        const pieces = Math.round(length / 0.16);
        for (let piece = 0; piece <= pieces; piece++) b.cyl(0.04, 0.3, [-length / 2 + (length * piece) / pieces, 0.09, 0], toned(cap, 1.15), { sides: 6, surface: 'clay', vary: 0.1 }, [QUARTER, 0, 0]);
      },
      [0, turn, 0],
    );
  }
}

/** 옹기: a glazed jar with its lid, standing on `at`. */
export function jar(b: Builder, at: V3, scale = 1, color = '#5b3d2c'): void {
  b.group(
    at,
    () => {
      b.ball(0.2, [0, 0.21, 0], color, { scale: [1, 1.12, 1], rough: 0.32, detail: 18 });
      b.cyl(0.13, 0.07, [0, 0.42, 0], color, { top: 0.12, rough: 0.32 });
      b.cyl(0.155, 0.05, [0, 0.47, 0], toned(color, 0.8), { top: 0.07, rough: 0.4 });
      b.ball(0.03, [0, 0.51, 0], toned(color, 0.8), { rough: 0.4, detail: 8 });
    },
    0,
    scale,
  );
}

/** A terracotta pot with something growing in it. */
export function pot(b: Builder, at: V3, scale: number, leaves: Palette, blooms?: Palette, color = '#b86a48'): void {
  b.group(
    at,
    () => {
      b.cyl(0.11, 0.2, [0, 0.1, 0], color, { top: 0.15, surface: 'clay', rough: 0.85 });
      b.cyl(0.16, 0.035, [0, 0.2, 0], color, { surface: 'clay', rough: 0.85 });
      for (let spray = 0; spray < 9; spray++) {
        const angle = b.between(0, TAU);
        const away = b.between(0, 0.1);
        b.sprig('leaf', [Math.cos(angle) * away, 0.26 + b.between(0, 0.12), Math.sin(angle) * away], b.between(0.2, 0.28), b.pick(leaves), [Math.cos(angle) * 0.5, 1, Math.sin(angle) * 0.5], b.between(0, TAU), [0, 1, 0], b.between(0.8, 1.05));
        if (blooms) b.sprig('bloom', [Math.cos(angle) * away * 1.3, 0.36 + b.between(0, 0.1), Math.sin(angle) * away * 1.3], b.between(0.09, 0.13), b.pick(blooms), [Math.cos(angle) * 0.3, 1, Math.sin(angle) * 0.3], b.between(0, TAU));
      }
    },
    0,
    scale,
  );
}

/** Split logs stacked along x on `at`. */
export function woodpile(b: Builder, at: V3, turn = 0, rows = 3): void {
  b.group(
    at,
    () => {
      for (let row = 0; row < rows; row++) {
        const count = 5 - row;
        for (let index = 0; index < count; index++) {
          const z = (index - (count - 1) / 2) * 0.15;
          const y = 0.075 + row * 0.13;
          b.cyl(0.072, 0.5, [b.between(-0.02, 0.02), y, z], b.pick(['#8b6444', '#9a7350', '#7a5639']), { sides: 8, surface: 'bark', rough: 0.95 }, [0, 0, QUARTER]);
          b.cyl(0.062, 0.006, [0.253, y, z], '#d9bd92', { sides: 8, surface: 'wood', rough: 0.9, vary: 0.1 }, [0, 0, QUARTER]);
        }
      }
    },
    turn,
  );
}

/** A round table with chairs about it. */
export function tableSet(b: Builder, at: V3, chairs: number, look: { wood?: string; turn?: number } = {}): void {
  const { wood = '#7a5a40', turn = 0 } = look;
  const finish: Finish = { surface: 'wood', rough: 0.7 };
  b.group(
    at,
    () => {
      b.cyl(0.28, 0.025, [0, 0.36, 0], wood, { ...finish, sides: 20 });
      b.cyl(0.025, 0.36, [0, 0.18, 0], wood, { ...finish, sides: 8 });
      b.cyl(0.13, 0.02, [0, 0.01, 0], wood, { ...finish, sides: 12 });
      for (let chair = 0; chair < chairs; chair++) {
        const angle = (chair / chairs) * TAU + 0.5;
        b.group(
          [Math.cos(angle) * 0.46, 0, Math.sin(angle) * 0.46],
          () => {
            b.box([0.2, 0.02, 0.2], [0, 0.21, 0], wood, finish);
            for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) b.box([0.02, 0.21, 0.02], [x * 0.085, 0.105, z * 0.085], wood, finish);
            b.box([0.2, 0.2, 0.018], [0, 0.34, -0.095], wood, finish, [-0.12, 0, 0]);
          },
          QUARTER - angle + Math.PI,
        );
      }
    },
    turn,
  );
}

/** 파라솔: a garden umbrella standing on `at`. */
export function parasol(b: Builder, at: V3, color = '#f1e3cc'): void {
  b.group(at, () => {
    b.cyl(0.014, 1.05, [0, 0.525, 0], '#6b4a35', { surface: 'wood', sides: 6 });
    b.cone(0.72, 0.2, [0, 1.07, 0], color, { sides: 8, rough: 0.9, twoSided: true });
    b.cyl(0.72, 0.05, [0, 0.95, 0], toned(color, 0.95), { top: 0.72, sides: 8, rough: 0.9, twoSided: true });
    b.cyl(0.1, 0.05, [0, 0.025, 0], '#4a4542', { sides: 10, rough: 0.8 });
  });
}

/** A rowing boat afloat, its keel along x, about `at` on the water. */
export function boat(b: Builder, at: V3, turn = 0, color = '#7a5236'): void {
  const wood: Finish = { surface: 'wood', rough: 0.75 };
  b.group(
    at,
    () => {
      b.ball(0.5, [0, 0.03, 0], color, { scale: [1.5, 0.3, 0.52], ...wood, detail: 18 });
      b.ball(0.46, [0, 0.07, 0], toned(color, 0.55), { scale: [1.42, 0.2, 0.44], rough: 0.9, detail: 14 });
      for (const x of [-0.25, 0.22]) b.box([0.1, 0.02, 0.42], [x, 0.11, 0], toned(color, 1.25), wood);
      b.box([0.03, 0.03, 0.9], [0, 0.14, 0.05], '#a98458', wood, [0, 0.5, 0.06]);
    },
    turn,
  );
}

/** A jetty of planks on posts running out over the water along +z from `at`, its deck at height `y`. */
export function jetty(b: Builder, at: V3, length: number, width: number, look: { wood?: string; lamp?: boolean } = {}, turn = 0): void {
  const { wood = '#9a7a5a', lamp = true } = look;
  const finish: Finish = { surface: 'wood', rough: 0.85, vary: 0.12 };
  b.group(
    at,
    () => {
      const planks = Math.round(length / 0.14);
      for (let plank = 0; plank < planks; plank++) b.box([width, 0.03, 0.125], [0, 0, (plank + 0.5) * (length / planks)], wood, finish);
      for (const side of [-1, 1]) {
        b.box([0.05, 0.05, length], [side * (width / 2 - 0.05), -0.04, length / 2], toned(wood, 0.75), finish);
        for (let post = 0; post < 3; post++) b.cyl(0.04, 0.9, [side * (width / 2 - 0.02), -0.3, 0.15 + (post / 2) * (length - 0.3)], toned(wood, 0.65), { sides: 8, surface: 'bark' });
      }
      if (lamp) lantern(b, [width / 2 - 0.02, 0.16, length - 0.15], { kind: 'path', height: 0.3 });
    },
    turn,
  );
}
