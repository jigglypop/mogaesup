import { Color } from 'three';

import type { Builder, SprigKind, V3 } from './build';
import { noise3 } from './noise';

// What grows: trees with their limbs and crowns of leaves, pines, willows, bamboo, shrubs in flower, beds, lawns, reeds
// and the stones among them. Each is handed to a Builder as limbs (real geometry) and sprigs (leaves, blades and
// flowers scattered by the hundred).

export type Palette = readonly string[];

const TAU = Math.PI * 2;
const BARK = { surface: 'bark', rough: 0.95 } as const;

const unit = (x: number, y: number, z: number): V3 => {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
};

/** `hex`, `by` times as bright. */
export function toned(hex: string, by: number): string {
  return `#${new Color(hex).multiplyScalar(by).getHexString()}`;
}

/** A direction, any way round and up or down. */
function anyWay(b: Builder): V3 {
  const y = b.between(-1, 1);
  const turn = b.between(0, TAU);
  const flat = Math.sqrt(1 - y * y);
  return [Math.cos(turn) * flat, y, Math.sin(turn) * flat];
}

/**
 * Fills a crown (an egg `radii` about `centre`) with `count` sprigs `size` big: thick near its surface, lumpy, darker
 * toward its heart and underside. Nothing hangs below `floor` (-1 the whole egg, 0 its upper half).
 */
export function crown(b: Builder, centre: V3, radii: V3, kind: SprigKind, colors: Palette, count: number, size: number, floor = -0.4): void {
  const seed = centre[0] * 3.1 + centre[2] * 7.3 + centre[1];
  const sprigs = Math.round(count * b.density);
  for (let index = 0; index < sprigs; index++) {
    const way = anyWay(b);
    if (way[1] < floor) way[1] = floor + (floor - way[1]) * 0.6;
    const lump = 0.84 + noise3(way[0] * 1.8 + seed, way[1] * 1.8, way[2] * 1.8, 3) * 0.34;
    const depth = Math.sqrt(b.random());
    const shell = (0.5 + depth * 0.5) * lump;
    const at: V3 = [centre[0] + way[0] * radii[0] * shell, centre[1] + way[1] * radii[1] * shell, centre[2] + way[2] * radii[2] * shell];
    const out = unit(way[0] / radii[0], way[1] / radii[1], way[2] / radii[2]);
    const shade = (0.6 + depth * 0.4) * (0.8 + (way[1] * 0.5 + 0.5) * 0.3);
    b.sprig(kind, at, size * b.between(0.75, 1.3), b.pick(colors), unit(out[0], out[1] + 0.35, out[2]), b.between(0, TAU), out, shade);
  }
}

export type TreeLook = {
  height: number;
  /** The crown's width. */
  spread: number;
  bark: string;
  leaves: Palette;
  kind?: SprigKind;
  /** How many masses the crown is made of. */
  lobes?: number;
  /** The trunk's radius at chest height. */
  girth?: number;
  /** A leaf spray's size. */
  leaf?: number;
  density?: number;
  /** How far the trunk leans, as a share of its height. */
  lean?: number;
  /** Where the crown begins, as a share of the height. */
  fork?: number;
  /** A mass's height against its width. */
  flat?: number;
  /** Flowers over the crown: their colours, and how many for each leaf spray. */
  blooms?: { colors: Palette; share: number; size?: number };
  /** Fruit hanging in it, of this colour. */
  fruit?: string;
};

/** A broad-leaved tree standing at `at`: a trunk, a limb to each mass of its crown, and the crown. */
export function tree(b: Builder, at: V3, look: TreeLook): void {
  const { height, spread, bark, leaves, kind = 'leaf', lobes = 5, girth = height * 0.042, leaf = 0.27, density = 1, lean = 0.12, fork = 0.42, flat = 0.74 } = look;
  b.group(at, () => {
    const turn = b.between(0, TAU);
    const forkAt = height * fork;
    const top: V3 = [Math.cos(turn) * lean * height * 0.5, forkAt, Math.sin(turn) * lean * height * 0.5];
    b.limb(
      [[0, -0.2, 0], [top[0] * 0.1, forkAt * 0.12, top[2] * 0.1], [top[0] * 0.55, forkAt * 0.62, top[2] * 0.55], top],
      [girth * 1.9, girth * 1.15, girth * 0.92, girth * 0.82],
      bark,
      BARK,
    );
    const tall = height - forkAt;
    const reach = spread / 2;
    const heart = toned(leaves[0]!, 0.42);
    for (let index = 0; index < lobes; index++) {
      const first = index === 0;
      const angle = turn + (index / Math.max(1, lobes - 1)) * TAU + b.between(-0.3, 0.3);
      const away = first ? 0.08 : b.between(0.44, 0.62);
      const centre: V3 = [top[0] + Math.cos(angle) * reach * away, forkAt + tall * (first ? 0.66 : b.between(0.26, 0.5)), top[2] + Math.sin(angle) * reach * away];
      const radius = reach * (first ? 0.64 : b.between(0.44, 0.58));
      const radii: V3 = [radius, radius * flat, radius];
      const elbow: V3 = [(top[0] + centre[0]) / 2 + b.between(-0.1, 0.1), (top[1] + centre[1]) / 2 + tall * 0.07, (top[2] + centre[2]) / 2 + b.between(-0.1, 0.1)];
      b.limb([top, elbow, centre], [girth * 0.62, girth * 0.4, girth * 0.14], bark, { ...BARK, sides: 6 });
      // What shows between the leaves is the crown's own dark, not the sky.
      b.ball(radius * 0.66, centre, heart, { scale: [1, flat, 1], rough: 1, detail: 9 });
      const count = Math.round(radius * radius * 290 * density);
      crown(b, centre, radii, kind, leaves, count, leaf);
      if (look.blooms) crown(b, centre, [radii[0] * 1.04, radii[1] * 1.04, radii[2] * 1.04], 'bloom', look.blooms.colors, Math.round(count * look.blooms.share), look.blooms.size ?? leaf * 0.5, -0.15);
      if (look.fruit) {
        for (let hung = 0; hung < 6; hung++) {
          const way = anyWay(b);
          b.sprig('puff', [centre[0] + way[0] * radii[0] * 0.95, centre[1] - Math.abs(way[1]) * radii[1] * 0.7, centre[2] + way[2] * radii[2] * 0.95], 0.16, look.fruit);
        }
      }
    }
  });
}

/** A fir: boughs in tiers down a straight trunk, widest at the foot. */
export function conifer(b: Builder, at: V3, look: { height: number; radius: number; bark?: string; needles: Palette; tiers?: number }): void {
  const { height, radius, bark = '#5f4332', needles, tiers = 6 } = look;
  b.group(at, () => {
    const girth = height * 0.03;
    b.limb([[0, -0.15, 0], [0, height * 0.5, 0], [0, height * 0.98, 0]], [girth * 1.7, girth * 0.8, girth * 0.12], bark, BARK);
    const foot = height * 0.16;
    b.cone(radius * 0.72, height - foot, [0, foot + (height - foot) / 2, 0], toned(needles[0]!, 0.4), { rough: 1, sides: 10 });
    const count = Math.round(radius * height * 150);
    for (let index = 0; index < count; index++) {
      // More boughs low down, where the rings are wide.
      const up = 1 - Math.sqrt(1 - b.random() * 0.98);
      const tier = (up * tiers) % 1;
      const ring = radius * (1 - up) * (1.12 - tier * 0.4) * b.between(0.72, 1.02) + 0.04;
      const angle = b.between(0, TAU);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const shade = (0.66 + (1 - tier) * 0.34) * b.between(0.88, 1.08);
      b.sprig('needle', [cos * ring, foot + (height - foot) * up, sin * ring], b.between(0.3, 0.44), b.pick(needles), unit(cos, -0.2 + up * 0.9, sin), b.between(0, TAU), unit(cos, 0.5, sin), shade);
    }
  });
}

/** 소나무: a red trunk that wanders, and needles in flat clouds at its branches' ends. */
export function pine(b: Builder, at: V3, look: { height: number; spread: number; bark?: string; needles: Palette }): void {
  const { height, spread, bark = '#9b5b3d', needles } = look;
  b.group(at, () => {
    const turn = b.between(0, TAU);
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const sway = spread * 0.2;
    const girth = height * 0.03;
    const spine: V3[] = [
      [0, -0.2, 0],
      [cos * sway * 0.3, height * 0.16, sin * sway * 0.3],
      [cos * sway, height * 0.38, sin * sway],
      [-cos * sway * 0.45, height * 0.62, -sin * sway * 0.45],
      [cos * sway * 0.35, height * 0.84, sin * sway * 0.35],
    ];
    b.limb(spine, [girth * 1.8, girth * 1.2, girth, girth * 0.8, girth * 0.5], bark, BARK);
    const heart = toned(needles[0]!, 0.4);
    const pads: { from: V3; centre: V3; radius: number }[] = [{ from: spine[4]!, centre: [spine[4]![0], height * 0.93, spine[4]![2]], radius: spread * 0.34 }];
    for (const [index, joint] of [2, 3, 3, 4].entries()) {
      const angle = turn + 1.2 + index * 1.7 + b.between(-0.3, 0.3);
      const from = spine[joint]!;
      const away = spread * b.between(0.34, 0.48);
      pads.push({ from, centre: [from[0] + Math.cos(angle) * away, from[1] + height * b.between(0.02, 0.1), from[2] + Math.sin(angle) * away], radius: spread * b.between(0.22, 0.3) });
    }
    for (const { from, centre, radius } of pads) {
      const under: V3 = [centre[0], centre[1] - radius * 0.2, centre[2]];
      b.limb([from, [(from[0] + under[0]) / 2, (from[1] + under[1]) / 2 + 0.05, (from[2] + under[2]) / 2], under], [girth * 0.5, girth * 0.32, girth * 0.14], bark, { ...BARK, sides: 6 });
      b.ball(radius * 0.6, centre, heart, { scale: [1, 0.26, 1], rough: 1, detail: 9 });
      crown(b, centre, [radius, radius * 0.36, radius], 'needle', needles, Math.round(radius * radius * 640), 0.36, -0.1);
    }
  });
}

/** 버드나무: limbs arching out and its leaves hanging from them in strands, nearly to the ground. */
export function willow(b: Builder, at: V3, look: { height: number; spread: number; bark?: string; leaves: Palette }): void {
  const { height, spread, bark = '#6f5a44', leaves } = look;
  b.group(at, () => {
    const girth = height * 0.05;
    const forkAt = height * 0.5;
    const top: V3 = [0.12, forkAt, -0.05];
    b.limb([[0, -0.2, 0], [0.04, forkAt * 0.4, 0], top], [girth * 1.9, girth * 1.1, girth * 0.85], bark, BARK);
    crown(b, [top[0], height * 0.9, top[2]], [spread * 0.3, height * 0.14, spread * 0.3], 'leaf', leaves, 150, 0.26, -0.2);
    const limbs = 8;
    for (let index = 0; index < limbs; index++) {
      const angle = (index / limbs) * TAU + b.between(-0.25, 0.25);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const reach = (spread / 2) * b.between(0.8, 1.05);
      const crest: V3 = [top[0] + cos * reach * 0.55, height * b.between(0.9, 1), top[2] + sin * reach * 0.55];
      const end: V3 = [top[0] + cos * reach, height * 0.78, top[2] + sin * reach];
      b.limb([top, [top[0] + cos * reach * 0.25, height * 0.8, top[2] + sin * reach * 0.25], crest, end], [girth * 0.5, girth * 0.34, girth * 0.2, girth * 0.08], bark, { ...BARK, sides: 6 });
      for (let strand = 0; strand < 10; strand++) {
        const along = b.between(0.25, 1);
        const from: V3 = [crest[0] + (end[0] - crest[0]) * along + b.between(-0.25, 0.25), crest[1] + (end[1] - crest[1]) * along, crest[2] + (end[2] - crest[2]) * along + b.between(-0.25, 0.25)];
        const hang = (from[1] - 0.45) * b.between(0.55, 0.98);
        const steps = Math.max(3, Math.round(hang / 0.15));
        for (let step = 0; step < steps; step++) {
          const down = step / steps;
          b.sprig(
            'leaf',
            [from[0] + cos * down * 0.2 + b.between(-0.04, 0.04), from[1] - down * hang, from[2] + sin * down * 0.2 + b.between(-0.04, 0.04)],
            [0.17, 0.3, 0.17],
            b.pick(leaves),
            unit(cos * 0.2, -1, sin * 0.2),
            b.between(0, TAU),
            unit(cos, 0.4, sin),
            0.75 + (1 - down) * 0.3,
          );
        }
      }
    }
  });
}

/** 자작나무: a slender white trunk marked with black, a light crown. */
export function birch(b: Builder, at: V3, look: { height: number; leaves: Palette }): void {
  const { height, leaves } = look;
  tree(b, at, { height, spread: height * 0.42, bark: '#ece8dd', leaves, lobes: 4, girth: height * 0.022, lean: 0.03, fork: 0.56, flat: 1, leaf: 0.24, density: 0.8 });
  b.group(at, () => {
    for (let mark = 0; mark < 7; mark++) {
      const angle = b.between(0, TAU);
      const radius = height * 0.021;
      b.box([0.07, 0.022, 0.012], [Math.cos(angle) * radius, height * b.between(0.08, 0.52), Math.sin(angle) * radius], '#3d3a36', { rough: 0.9 }, Math.PI / 2 - angle);
    }
  });
}

/** 대나무: canes with their joints, leaves in sprays from the upper ones. */
export function bamboo(b: Builder, at: V3, look: { canes: number; height: number; reach: number; cane?: string; leaves?: Palette }): void {
  const { canes, height, reach, cane = '#86a85c', leaves = ['#8fb35a', '#a3c268', '#7ba04e'] } = look;
  b.group(at, () => {
    for (let index = 0; index < canes; index++) {
      const angle = b.between(0, TAU);
      const away = Math.sqrt(b.random()) * reach;
      const x = Math.cos(angle) * away;
      const z = Math.sin(angle) * away;
      const tall = height * b.between(0.68, 1);
      const lean = b.between(0.05, 0.16) * tall;
      const point = (t: number): V3 => [x + Math.cos(angle) * lean * t * t, tall * t, z + Math.sin(angle) * lean * t * t];
      b.limb([point(0), point(0.35), point(0.7), point(1)], [0.036, 0.032, 0.026, 0.012], cane, { rough: 0.45, sides: 6 });
      for (let joint = 1; joint < 9; joint++) {
        const t = joint / 9;
        const here = point(t);
        b.cyl(0.04 - t * 0.014, 0.014, here, toned(cane, 0.6), { rough: 0.5, sides: 6 });
        if (t < 0.42) continue;
        for (let spray = 0; spray < 4; spray++) {
          const turn = b.between(0, TAU);
          b.sprig('frond', [here[0], here[1], here[2]], b.between(0.34, 0.5), b.pick(leaves), unit(Math.cos(turn), b.between(-0.1, 0.5), Math.sin(turn)), b.between(0, TAU), [0, 1, 0], b.between(0.85, 1.1));
        }
      }
    }
  });
}

export type Blooms = { colors: Palette; count: number; kind?: 'bloom' | 'puff'; size?: number };

/** A shrub `radius` wide sitting on the ground at `at`, in flower when `blooms` is given. */
export function bush(b: Builder, at: V3, radius: number, leaves: Palette, blooms?: Blooms, squat = 0.78): void {
  const centre: V3 = [at[0], at[1] + radius * squat * 0.4, at[2]];
  const radii: V3 = [radius, radius * squat, radius];
  b.ball(radius * 0.72, centre, toned(leaves[0]!, 0.42), { scale: [1, squat, 1], rough: 1, detail: 8 });
  crown(b, centre, radii, 'leaf', leaves, Math.round(radius * radius * 300) + 14, 0.26, -0.25);
  if (!blooms) return;
  const { colors, count, kind = 'bloom', size = 0.11 } = blooms;
  for (let index = 0; index < count; index++) {
    const way = anyWay(b);
    way[1] = Math.abs(way[1]) * 0.9 + 0.05;
    const out = unit(way[0], way[1], way[2]);
    b.sprig(kind, [centre[0] + out[0] * radii[0] * 1.03, centre[1] + out[1] * radii[1] * 1.03, centre[2] + out[2] * radii[2] * 1.03], size * b.between(0.8, 1.3), b.pick(colors), unit(out[0], out[1] + 0.6, out[2]), b.between(0, TAU), out);
  }
}

/**
 * A bed of flowers: `count` plants over the oval `reach` about `centre` on the ground (y = `y`), each a tuft of leaves
 * with its flowers held `height` above. `keep` leaves out where something else stands.
 */
export function flowerBed(
  b: Builder,
  centre: [number, number],
  reach: [number, number],
  count: number,
  blooms: Palette,
  look: { leaves?: Palette; height?: [number, number]; size?: number; y?: number; kind?: 'bloom' | 'puff'; keep?: (x: number, z: number) => boolean } = {},
): void {
  const { leaves = ['#4f8a45', '#5f9a50', '#447a3e'], height = [0.16, 0.34], size = 0.1, y = 0, kind = 'bloom', keep } = look;
  for (let index = 0; index < count; index++) {
    const angle = b.between(0, TAU);
    const away = Math.sqrt(b.random());
    const x = centre[0] + Math.cos(angle) * away * reach[0];
    const z = centre[1] + Math.sin(angle) * away * reach[1];
    if (keep && !keep(x, z)) continue;
    const tall = b.between(height[0], height[1]);
    b.sprig('leaf', [x, y + tall * 0.25, z], [0.2, tall * 1.5, 0.2], b.pick(leaves), [0, 1, 0], b.between(0, TAU), [0, 1, 0], b.between(0.75, 1));
    const heads = 1 + Math.floor(b.random() * 2.4);
    for (let head = 0; head < heads; head++) {
      b.sprig(kind, [x + b.between(-0.07, 0.07), y + tall * b.between(0.85, 1.1), z + b.between(-0.07, 0.07)], size * b.between(0.8, 1.3), b.pick(blooms), unit(b.between(-0.3, 0.3), 1, b.between(-0.3, 0.3)), b.between(0, TAU), [0, 1, 0]);
    }
  }
}

/** Grass over whatever ground `open` allows, `count` tufts tried over a square `half` to each side. */
export function lawn(b: Builder, open: (x: number, z: number) => boolean, count: number, colors: Palette, look: { half?: number; size?: [number, number] } = {}): void {
  const { half = 6.2, size = [0.15, 0.27] } = look;
  const tufts = Math.round(count * (b.density < 1 ? 0.45 : 1));
  for (let index = 0; index < tufts; index++) {
    const x = b.between(-half, half);
    const z = b.between(-half, half);
    if (!open(x, z)) continue;
    const wide = b.between(size[0], size[1]);
    b.sprig('blade', [x, 0, z], [wide, wide * b.between(0.7, 1.5), wide], b.pick(colors), [0, 1, 0], b.between(0, TAU), [0, 1, 0], b.between(0.8, 1.08));
  }
}

/** Reeds standing in the shallows about `at`. */
export function reeds(b: Builder, at: V3, count: number, reach: number, colors: Palette = ['#7d9a55', '#8fae62', '#6c8a4a'], heads = true): void {
  for (let index = 0; index < count; index++) {
    const angle = b.between(0, TAU);
    const away = Math.sqrt(b.random()) * reach;
    const x = at[0] + Math.cos(angle) * away;
    const z = at[2] + Math.sin(angle) * away;
    const tall = b.between(0.55, 1.05);
    const lean = unit(b.between(-0.22, 0.22), 1, b.between(-0.22, 0.22));
    b.sprig('frond', [x, at[1], z], [0.6, tall, 0.6], b.pick(colors), lean, b.between(0, TAU), [0, 1, 0], b.between(0.8, 1.1));
    if (heads && index % 3 === 0) b.sprig('puff', [x + lean[0] * tall * 0.8, at[1] + tall * 0.82, z + lean[2] * tall * 0.8], [0.05, 0.17, 0.05], '#6b4630', lean);
  }
}

/** Lily pads lying on water at height `y` about a point, some of them in flower. */
export function lilies(b: Builder, centre: [number, number], y: number, reach: [number, number], count: number, flowers: Palette = ['#ffd0dc', '#fff4f2', '#f6a9c0']): void {
  for (let index = 0; index < count; index++) {
    const angle = b.between(0, TAU);
    const away = Math.sqrt(b.random());
    const x = centre[0] + Math.cos(angle) * away * reach[0];
    const z = centre[1] + Math.sin(angle) * away * reach[1];
    const wide = b.between(0.2, 0.36);
    b.sprig('pad', [x, y + 0.012, z], wide, b.pick(['#4f8f4a', '#5b9c52', '#447f45']), [0, 1, 0], b.between(0, TAU), [0, 1, 0], b.between(0.85, 1.1));
    if (index % 3 === 0) b.sprig('bloom', [x + wide * 0.2, y + 0.05, z], b.between(0.14, 0.2), b.pick(flowers), [0, 1, 0], b.between(0, TAU));
  }
}

/**
 * Something climbing a wall: leaves over the stretch `width` by `height` that stands on `foot` and faces +z, thickest
 * low down and at its edges. Call it inside a group turned to the wall.
 */
export function vine(b: Builder, foot: V3, width: number, height: number, leaves: Palette, blooms?: { colors: Palette; share: number }, density = 1): void {
  const count = Math.round(width * height * 110 * density * b.density);
  const seed = foot[0] * 5.1 + foot[1] * 3.3 + foot[2] * 1.7;
  for (let index = 0; index < count; index++) {
    const across = b.between(-0.5, 0.5);
    const up = b.random() ** 1.25;
    const cover = noise3(across * 2.4 + seed, up * 2.8, seed, 7) + Math.abs(across) * 0.25 - up * 0.2;
    if (cover < 0.46) continue;
    const at: V3 = [foot[0] + across * width, foot[1] + up * height, foot[2] + b.between(0.02, 0.1)];
    b.sprig('leaf', at, b.between(0.17, 0.26), b.pick(leaves), unit(b.between(-0.5, 0.5), 0.5, 1), b.between(0, TAU), [0, 0.3, 1], b.between(0.75, 1.05));
    if (blooms && b.random() < blooms.share) b.sprig('bloom', [at[0], at[1], at[2] + 0.07], b.between(0.09, 0.13), b.pick(blooms.colors), unit(b.between(-0.3, 0.3), 0.4, 1), b.between(0, TAU));
  }
}

/** A stone about `size` across sitting on the ground at `at`; `squash` flattens it (a stepping stone is 0.2). */
export function rock(b: Builder, at: V3, size: number, color: string, squash = 0.7): void {
  const tall = size * squash * b.between(0.85, 1.15);
  b.sprig(size < 0.42 ? 'pebble' : 'rock', [at[0], at[1] + tall * 0.2, at[2]], [size * b.between(0.85, 1.25), tall, size * b.between(0.85, 1.2)], color, unit(b.between(-0.12, 0.12), 1, b.between(-0.12, 0.12)), b.between(0, TAU), [0, 1, 0], b.between(0.82, 1.1));
}

/** Flat stones laid as a path through `points` on the ground, about `width` wide. */
export function steppingStones(b: Builder, points: readonly [number, number][], width: number, colors: Palette): void {
  for (let leg = 0; leg < points.length - 1; leg++) {
    const from = points[leg]!;
    const to = points[leg + 1]!;
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const stones = Math.max(1, Math.round(length / (width * 0.82)));
    for (let index = 0; index < stones; index++) {
      const t = (index + 0.5) / stones;
      const size = width * b.between(0.8, 1.1);
      b.sprig(
        'pebble',
        [from[0] + (to[0] - from[0]) * t + b.between(-0.08, 0.08), 0.0, from[1] + (to[1] - from[1]) * t + b.between(-0.06, 0.06)],
        [size, 0.13, size * b.between(0.7, 0.95)],
        b.pick(colors),
        [0, 1, 0],
        b.between(0, TAU),
        [0, 1, 0],
        b.between(0.9, 1.08),
      );
    }
  }
}
