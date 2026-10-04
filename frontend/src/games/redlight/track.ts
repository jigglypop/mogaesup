import type { BuildingSerializedState } from 'gaesup-world/building';

import { CELL } from '../../minihome/village';
import type { Vec3 } from '../protocol';

/** The finish lies 16 to 60 m from the start over the ground, as the server takes it. */
export const SHORTEST = 16;
export const LONGEST = 60;
/** How far to each side of the start the players' line reaches: the server's is at most 8 m across. */
const LINE_REACH = 4;
/** How often along a line the ground under it is looked at, in meters. */
const STEP = 0.5;
/** Half a floor cell, and a hair for rounding: a point this near a spot on both axes stands on that spot's cell. */
const HALF = CELL / 2 + 1e-6;

export type Track = { start: Vec3; finish: Vec3 };
/** A stretch of the ground from (x1, z1) to (x2, z2). */
export type Segment = [x1: number, z1: number, x2: number, z2: number];

const apart = (a: Vec3, b: Vec3) => Math.hypot(b[0] - a[0], b[2] - a[2]);
const cellOf = (x: number, z: number) => `${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;

/** The island's walls on the ground: each one cell long along its own x, about its position. */
export function wallsOf(building: BuildingSerializedState): Segment[] {
  return building.wallGroups
    .flatMap((group) => group.walls)
    .map(({ position, rotation }) => {
      const [x, z] = [(Math.cos(rotation.y) * CELL) / 2, (-Math.sin(rotation.y) * CELL) / 2];
      return [position.x - x, position.z - z, position.x + x, position.z + z];
    });
}

/** Which side of the line through (ax, az) and (bx, bz) the point (px, pz) is on: -1, 0 (on it) or 1. */
const side = (ax: number, az: number, bx: number, bz: number, px: number, pz: number) =>
  Math.sign((bx - ax) * (pz - az) - (bz - az) * (px - ax));

/** Whether two stretches cross or touch. */
export function crosses([ax, az, bx, bz]: Segment, [cx, cz, dx, dz]: Segment): boolean {
  return side(ax, az, bx, bz, cx, cz) * side(ax, az, bx, bz, dx, dz) <= 0 && side(cx, cz, dx, dz, ax, az) * side(cx, cz, dx, dz, bx, bz) <= 0;
}

/** Whether a point on the ground lies on the floor cell of one of `spots` (cell centres, as `openSpots` gives them). */
export function openGround(spots: readonly Vec3[]): (x: number, z: number) => boolean {
  const cells = new Map<string, Vec3[]>();
  for (const spot of spots) {
    const key = cellOf(spot[0], spot[2]);
    const cell = cells.get(key);
    if (cell) cell.push(spot);
    else cells.set(key, [spot]);
  }
  return (x, z) => {
    const [i, j] = [Math.floor(x / CELL), Math.floor(z / CELL)];
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const spot of cells.get(`${i + di}:${j + dj}`) ?? []) {
          if (Math.abs(spot[0] - x) <= HALF && Math.abs(spot[2] - z) <= HALF) return true;
        }
      }
    }
    return false;
  };
}

export type TrackOptions = {
  /** The island's open cells (`spots` themselves by default): a clear line runs over them alone. */
  ground?: readonly Vec3[];
  /** Walls a clear line may not cross. */
  walls?: readonly Segment[];
};

/**
 * The host's track for 무궁화 꽃이 피었습니다: two of `spots` 16 to 60 m apart, the farthest apart along a clear straight
 * line (over open ground, through no wall) with room across the start for the players' line, run northward (away from
 * the camera) when the start has room either way. Without one, the longest clear line; without that, the farthest pair.
 * Throws when no two spots are far enough apart.
 */
export function findTrack(spots: readonly Vec3[], { ground = spots, walls = [] }: TrackOptions = {}): Track {
  const open = openGround(ground);
  const walled = (x1: number, z1: number, x2: number, z2: number) => walls.some((wall) => crosses([x1, z1, x2, z2], wall));
  const clear = (a: Vec3, b: Vec3) => {
    if (walled(a[0], a[2], b[0], b[2])) return false;
    const steps = Math.ceil(apart(a, b) / STEP);
    for (let step = 1; step < steps; step++) {
      const t = step / steps;
      if (!open(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t)) return false;
    }
    return true;
  };
  const roomy = (start: Vec3, finish: Vec3) => {
    const length = apart(start, finish);
    // Across the track, one meter long.
    const [x, z] = [-(finish[2] - start[2]) / length, (finish[0] - start[0]) / length];
    const reach = [start[0] - x * LINE_REACH, start[2] - z * LINE_REACH, start[0] + x * LINE_REACH, start[2] + z * LINE_REACH] as const;
    if (walled(...reach)) return false;
    for (let aside = 1; aside <= LINE_REACH; aside++) {
      if (!open(start[0] + x * aside, start[2] + z * aside) || !open(start[0] - x * aside, start[2] - z * aside)) return false;
    }
    return true;
  };
  const pairs: { a: Vec3; b: Vec3; length: number }[] = [];
  spots.forEach((a, index) => {
    for (const b of spots.slice(index + 1)) {
      const length = apart(a, b);
      if (length >= SHORTEST && length <= LONGEST) pairs.push({ a, b, length });
    }
  });
  if (!pairs.length) throw new Error('달릴 만큼 넓은 곳이 없어요.');
  pairs.sort((first, second) => second.length - first.length);
  const northward = ({ a, b }: { a: Vec3; b: Vec3 }): Track => (a[2] >= b[2] ? { start: a, finish: b } : { start: b, finish: a });
  let longestClear: Track | null = null;
  for (const pair of pairs) {
    if (!clear(pair.a, pair.b)) continue;
    const track = northward(pair);
    if (roomy(track.start, track.finish)) return track;
    if (roomy(track.finish, track.start)) return { start: track.finish, finish: track.start };
    longestClear ??= track;
  }
  return longestClear ?? northward(pairs[0]!);
}
