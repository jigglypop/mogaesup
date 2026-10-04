import { CELL } from '../../minihome/village';
import type { Vec3 } from '../protocol';

/**
 * 축구's field as the server takes it (server/src/games/soccer.rs): its centre on the ground, the axis its long side
 * runs along, and half its length and width, in meters. Goals stand at both ends of the long side.
 */
export type Field = { center: Vec3; axis: 'x' | 'z'; halfLength: number; halfWidth: number };
/** The field as views carry it, with the goal mouth's width. */
export type FieldView = Field & { mouth: number };
/** The ball as views carry it: where it was at `at` (server ms) and its velocity then (m/s). */
export type BallView = { position: Vec3; velocity: Vec3; at: number };

/** The sizes the server takes. */
export const HALF_LENGTH = { min: 10, max: 24 } as const;
export const HALF_WIDTH = { min: 6, max: 14 } as const;
/** How far from the island's centre the server takes any part of the field, on each axis. */
const LIMIT = 200;
/** A field this far (m) from the host still counts as near them. */
const NEAR = 24;

// How the server rolls the ball.
const KEEP_PER_SECOND = 0.4;
const DECAY = -Math.log(KEEP_PER_SECOND);
const REST = 0.1;
const RESTITUTION = 0.6;
const STEP_MS = 5;
/** How far behind the end line a goal's net stops the ball (m). */
export const GOAL_DEPTH = 1.2;

/** Field coordinates `[u, v]` of a ground point: along the long side (toward B's goal) and across it. */
export function toField(field: Field, [x, , z]: Vec3): [number, number] {
  const [dx, dz] = [x - field.center[0], z - field.center[2]];
  return field.axis === 'x' ? [dx, dz] : [dz, dx];
}

/** The point on the field's plane at field coordinates `[u, v]`. */
export function fromField(field: Field, u: number, v: number): Vec3 {
  const [x, y, z] = field.center;
  return field.axis === 'x' ? [x + u, y, z + v] : [x + v, y, z + u];
}

/**
 * Where the ball is at `time` (server ms), rolled on from the last view as the server rolls it: slowing to 40% each
 * second, stopping below 0.1 m/s, bouncing off the lines at 60% but for the goal mouths, through which it runs on into
 * the net. The server's next view (a touch, a goal) takes over from it.
 */
export function rollBall(ball: BallView, field: FieldView, time: number): Vec3 {
  let [u, v] = toField(field, ball.position);
  let [vu, vv] = field.axis === 'x' ? [ball.velocity[0], ball.velocity[2]] : [ball.velocity[2], ball.velocity[0]];
  const { halfLength: length, halfWidth: width } = field;
  const mouth = field.mouth / 2;
  const keep = KEEP_PER_SECOND ** (STEP_MS / 1000);
  const travel = (1 - keep) / DECAY;
  for (let at = ball.at; at + STEP_MS <= time && (vu !== 0 || vv !== 0); at += STEP_MS) {
    const [u0, v0] = [u, v];
    u += vu * travel;
    v += vv * travel;
    vu *= keep;
    vv *= keep;
    const inside = Math.abs(u0) <= length;
    if (inside && Math.abs(u) > length) {
      const end = Math.sign(u) * length;
      const crossed = v0 + ((v - v0) * (end - u0)) / (u - u0);
      if (Math.abs(crossed) > mouth) {
        u = end - (u - end) * RESTITUTION;
        vu = -vu * RESTITUTION;
      }
    }
    if (Math.abs(u) > length) {
      // In the goal: the net holds it.
      if (Math.abs(u) >= length + GOAL_DEPTH || Math.abs(v) >= mouth) [vu, vv] = [0, 0];
      u = Math.max(-length - GOAL_DEPTH, Math.min(length + GOAL_DEPTH, u));
      v = Math.max(-mouth, Math.min(mouth, v));
      continue;
    }
    if (Math.abs(v) > width) {
      const side = Math.sign(v) * width;
      v = side - (v - side) * RESTITUTION;
      vv = -vv * RESTITUTION;
    }
    if (Math.hypot(vu, vv) < REST) [vu, vv] = [0, 0];
  }
  return fromField(field, u, v);
}

const rounded = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** `field` moved (if need be) to lie wholly within the server's bounds, rounded to centimeters. */
function settled(field: Field): Field {
  const [reachX, reachZ] = field.axis === 'x' ? [field.halfLength, field.halfWidth] : [field.halfWidth, field.halfLength];
  const [x, y, z] = field.center;
  return {
    ...field,
    center: [rounded(clamp(x, reachX - LIMIT, LIMIT - reachX)), rounded(y), rounded(clamp(z, reachZ - LIMIT, LIMIT - reachZ))],
  };
}

/** The smallest field the server takes, centred on `at`. */
const smallest = (at: Vec3): Field => settled({ center: at, axis: 'x', halfLength: HALF_LENGTH.min, halfWidth: HALF_WIDTH.min });

/** Fields from the largest down, in cells per side: the long side 5 to 12 cells (20 to 48 m), the short 3 to 7. */
const SIZES: [number, number][] = [];
for (let long = (HALF_LENGTH.max * 2) / CELL; long >= (HALF_LENGTH.min * 2) / CELL; long--) {
  for (let short = Math.min(long, (HALF_WIDTH.max * 2) / CELL); short >= (HALF_WIDTH.min * 2) / CELL; short--) SIZES.push([long, short]);
}

type Candidate = { field: Field; area: number; near: boolean; away: number };

/**
 * The field to play on, from the island's open spots (cell centres on its grid) and where the host stands: the
 * largest rectangle of open cells within reach of the host (24 m), or else the largest anywhere, ties going to the one
 * nearest the host; its long side carries the goals. Sizes run from the smallest field the server takes (20 × 12 m) to
 * the largest (48 × 28 m). With no such rectangle, the smallest field goes where it covers the most open cells.
 */
export function findField(spots: readonly Vec3[], host: Vec3 | null): Field {
  const first = spots[0];
  if (!first) return smallest(host ?? [0, 0, 0]);
  const centroid: Vec3 = [0, 1, 2].map((axis) => spots.reduce((sum, spot) => sum + spot[axis]!, 0) / spots.length) as Vec3;
  const from = host ?? centroid;
  // Open cells on the grid through the first spot.
  const cell = (spot: Vec3) => [Math.round((spot[0] - first[0]) / CELL), Math.round((spot[2] - first[2]) / CELL)] as const;
  const keys = spots.map(cell);
  const [minI, minK] = [Math.min(...keys.map(([i]) => i)), Math.min(...keys.map(([, k]) => k))];
  const columns = Math.max(...keys.map(([i]) => i)) - minI + 1;
  const rows = Math.max(...keys.map(([, k]) => k)) - minK + 1;
  // Running sums over the grid of open cells and of their heights, for any rectangle's count and mean height.
  const count = new Float64Array((columns + 1) * (rows + 1));
  const height = new Float64Array((columns + 1) * (rows + 1));
  const index = (i: number, k: number) => k * (columns + 1) + i;
  const seen = new Set<number>();
  keys.forEach(([i, k], at) => {
    const slot = index(i - minI + 1, k - minK + 1);
    if (seen.has(slot)) return;
    seen.add(slot);
    count[slot] = 1;
    height[slot] = spots[at]![1];
  });
  for (let k = 1; k <= rows; k++) {
    for (let i = 1; i <= columns; i++) {
      for (const sums of [count, height]) {
        sums[index(i, k)] = sums[index(i, k)]! + sums[index(i - 1, k)]! + sums[index(i, k - 1)]! - sums[index(i - 1, k - 1)]!;
      }
    }
  }
  // A rectangle of cells from cell (i, k), which may overhang the grid: how many are open, and the field over it.
  const within = (value: number, size: number) => Math.max(0, Math.min(size, value));
  const total = (sums: Float64Array, i: number, k: number, w: number, d: number) => {
    const [i0, i1, k0, k1] = [within(i, columns), within(i + w, columns), within(k, rows), within(k + d, rows)];
    return sums[index(i1, k1)]! - sums[index(i0, k1)]! - sums[index(i1, k0)]! + sums[index(i0, k0)]!;
  };
  const place = (i: number, k: number, w: number, d: number, axis: Field['axis'], open: number): Field => ({
    center: [
      first[0] + (minI + i + (w - 1) / 2) * CELL,
      open ? total(height, i, k, w, d) / open : from[1],
      first[2] + (minK + k + (d - 1) / 2) * CELL,
    ],
    axis,
    halfLength: (Math.max(w, d) * CELL) / 2,
    halfWidth: (Math.min(w, d) * CELL) / 2,
  });
  const away = ({ center }: Field) => Math.hypot(from[0] - center[0], from[2] - center[2]);

  let best: Candidate | null = null;
  for (const [long, short] of SIZES) {
    for (const axis of ['x', 'z'] as const) {
      const [w, d] = axis === 'x' ? [long, short] : [short, long];
      for (let k = 0; k + d <= rows; k++) {
        for (let i = 0; i + w <= columns; i++) {
          if (total(count, i, k, w, d) < w * d) continue;
          const field = place(i, k, w, d, axis, w * d);
          // How far the host stands from it; inside, nothing.
          const gap = Math.hypot(
            Math.max(0, Math.abs(from[0] - field.center[0]) - (w * CELL) / 2),
            Math.max(0, Math.abs(from[2] - field.center[2]) - (d * CELL) / 2),
          );
          const candidate: Candidate = { field, area: long * short, near: gap <= NEAR, away: away(field) };
          if (!best || better(candidate, best)) best = candidate;
        }
      }
    }
  }
  if (best) return settled(best.field);
  // Nothing fits: the smallest field where it covers the most open cells, nearest the host.
  let most: { field: Field; open: number; away: number } | null = null;
  const [long, short] = [(HALF_LENGTH.min * 2) / CELL, (HALF_WIDTH.min * 2) / CELL];
  for (const axis of ['x', 'z'] as const) {
    const [w, d] = axis === 'x' ? [long, short] : [short, long];
    for (let k = 1 - d; k < rows; k++) {
      for (let i = 1 - w; i < columns; i++) {
        const open = total(count, i, k, w, d);
        const field = place(i, k, w, d, axis, open);
        if (!most || open > most.open || (open === most.open && away(field) < most.away)) most = { field, open, away: away(field) };
      }
    }
  }
  return most ? settled(most.field) : smallest(from);
}

/** Near the host before far; then larger; then nearer. */
function better(a: Candidate, b: Candidate): boolean {
  if (a.near !== b.near) return a.near;
  if (a.area !== b.area) return a.area > b.area;
  return a.away < b.away;
}
