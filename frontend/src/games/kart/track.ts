import { ARENA_Y } from '../arenaMap';
import type { Vec3 } from '../protocol';

/**
 * 카트's circuit, the same on every page: a closed loop in the sky over the island (see arenaMap.ts) with a long start
 * straight, two sweeping corners, a pair of hairpins, a chicane and a long back straight. Its middle line is made of
 * straight lines, circle arcs and one S; the gates the server counts are points on it, the first being the start line.
 * Points are on the ground of the track (`ARENA_Y`); x is east, z south.
 */

/** A point on the ground plan: x and z. */
export type Flat = [number, number];

/** Half the road's width, in meters. */
export const HALF_WIDTH = 6;
/** How near the middle of a gate a kart must come: the road and a little more. */
export const GATE_RADIUS = HALF_WIDTH + 2;
/** Where the track starts and which way it runs there. */
export const START: Flat = [-40, 100];
/** The heading karts start in: east (heading 0 faces south, +z; a quarter turn faces east, +x). */
export const START_HEADING = Math.PI / 2;

type Piece =
  | { kind: 'line'; to: Flat }
  /** A circle arc around `center`, turning `sweep` radians (negative: clockwise as x and z are drawn). */
  | { kind: 'arc'; center: Flat; sweep: number }
  /** An S across the line to `to`: out to one side and back to the other, `amplitude` meters at most. */
  | { kind: 's'; to: Flat; amplitude: number };

/** The middle line, from the start line round to it again. */
const PIECES: Piece[] = [
  { kind: 'line', to: [90, 100] },
  { kind: 'arc', center: [90, 70], sweep: -Math.PI / 2 },
  { kind: 'line', to: [120, 0] },
  { kind: 'arc', center: [100, 0], sweep: -Math.PI },
  { kind: 'line', to: [80, 40] },
  { kind: 'arc', center: [60, 40], sweep: Math.PI },
  { kind: 'line', to: [40, -40] },
  { kind: 'arc', center: [10, -40], sweep: -Math.PI / 2 },
  { kind: 's', to: [-90, -70], amplitude: 10 },
  { kind: 'arc', center: [-90, -40], sweep: -Math.PI / 2 },
  { kind: 'line', to: [-120, 70] },
  { kind: 'arc', center: [-90, 70], sweep: -Math.PI / 2 },
  { kind: 'line', to: START },
];

/** Gates at most this far apart on a straight, this many radians apart on an arc, and this many on an S. */
const GATE_STRAIGHT = 40;
const GATE_ARC = Math.PI / 8;
const GATE_S = 8;
/** How finely the middle line is drawn, in meters. */
const STEP = 1.5;

/** Points `count` + 1 along a piece from `from`: the shape of each kind, its ends included. */
function along(piece: Piece, from: Flat, count: number): Flat[] {
  const points: Flat[] = [];
  for (let index = 0; index <= count; index++) {
    const t = index / count;
    if (piece.kind === 'line') {
      points.push([from[0] + (piece.to[0] - from[0]) * t, from[1] + (piece.to[1] - from[1]) * t]);
    } else if (piece.kind === 'arc') {
      const [cx, cz] = piece.center;
      const radius = Math.hypot(from[0] - cx, from[1] - cz);
      const angle = Math.atan2(from[1] - cz, from[0] - cx) + piece.sweep * t;
      points.push([cx + radius * Math.cos(angle), cz + radius * Math.sin(angle)]);
    } else {
      // Along the chord, and across it by a curve that leaves and arrives straight: a smooth chicane.
      const [dx, dz] = [piece.to[0] - from[0], piece.to[1] - from[1]];
      const length = Math.hypot(dx, dz);
      const across = piece.amplitude * Math.sin(2 * Math.PI * t) * Math.sin(Math.PI * t);
      points.push([from[0] + dx * t - (dz / length) * across, from[1] + dz * t + (dx / length) * across]);
    }
  }
  return points;
}

function pieceLength(piece: Piece, from: Flat): number {
  if (piece.kind === 'arc') return Math.hypot(from[0] - piece.center[0], from[1] - piece.center[1]) * Math.abs(piece.sweep);
  const points = along(piece, from, 64);
  return points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point[0] - points[index]![0], point[1] - points[index]![1]), 0);
}

function gateCount(piece: Piece, from: Flat): number {
  if (piece.kind === 'line') return Math.max(1, Math.ceil(pieceLength(piece, from) / GATE_STRAIGHT));
  if (piece.kind === 'arc') return Math.max(1, Math.ceil(Math.abs(piece.sweep) / GATE_ARC - 1e-9));
  return GATE_S;
}

/** The pieces' gates and the finely drawn middle line, each from the start line round to just before it. */
function build(): { gates: Flat[]; line: Flat[] } {
  const gates: Flat[] = [];
  const line: Flat[] = [];
  let from = START;
  for (const piece of PIECES) {
    const gatePoints = along(piece, from, gateCount(piece, from));
    gates.push(...gatePoints.slice(0, -1));
    const fine = along(piece, from, Math.max(1, Math.ceil(pieceLength(piece, from) / STEP)));
    line.push(...fine.slice(0, -1));
    from = gatePoints.at(-1)!;
  }
  return { gates, line };
}

const BUILT = build();

/** Centimeters, as layouts carry points. */
const cm = (value: number) => Math.round(value * 100) / 100;
const ground = ([x, z]: Flat): Vec3 => [cm(x), ARENA_Y, cm(z)];

/** The gates in driving order, the start line first. */
export const GATES: readonly Flat[] = BUILT.gates;
/** The middle line, a point every 1.5 m or so, from the start line round (not repeating it). */
export const MIDDLE: readonly Flat[] = BUILT.line;

/** The unit direction the track runs at point `index` of `line` (a closed loop), and the one across it. */
export function frame(line: readonly Flat[], index: number): { ahead: Flat; across: Flat } {
  const count = line.length;
  const [before, after] = [line[(index + count - 1) % count]!, line[(index + 1) % count]!];
  const [dx, dz] = [after[0] - before[0], after[1] - before[1]];
  const length = Math.hypot(dx, dz) || 1;
  // A quarter turn of the way ahead, as the server's bots take the side of a lane.
  return { ahead: [dx / length, dz / length], across: [-dz / length, dx / length] };
}

/** `line` moved `offset` meters across itself (to the `across` side for a positive offset). */
export function offsetLine(line: readonly Flat[], offset: number): Flat[] {
  return line.map((point, index) => {
    const { across } = frame(line, index);
    return [point[0] + across[0] * offset, point[1] + across[1] * offset];
  });
}

/** The point of the middle line nearest `point`, by its index. */
export function nearest(point: Flat): number {
  let best = 0;
  let far = Infinity;
  MIDDLE.forEach((spot, index) => {
    const apart = Math.hypot(spot[0] - point[0], spot[1] - point[1]);
    if (apart < far) [best, far] = [index, apart];
  });
  return best;
}

/** `offset` meters across the middle line at its point nearest `at`, and `ahead` meters along it. */
function onRoad(at: Flat, across: number, ahead = 0): Flat {
  const index = nearest(at);
  const frameAt = frame(MIDDLE, index);
  const point = MIDDLE[index]!;
  return [point[0] + frameAt.across[0] * across + frameAt.ahead[0] * ahead, point[1] + frameAt.across[1] * across + frameAt.ahead[1] * ahead];
}

/** Eight slots behind the line in two staggered columns, each 2.6 m off the middle. */
export const GRID: readonly Flat[] = Array.from({ length: 8 }, (_, index) => {
  const row = Math.floor(index / 2);
  const right = index % 2 === 1;
  return onRoad(START, right ? 2.6 : -2.6, -6 - row * 7 - (right ? 3.5 : 0));
});

/** Rows of four item boxes across the road. */
const BOX_ROWS: Flat[] = [
  [20, 100],
  [120, 35],
  [40, 0],
  [-120, 15],
];
export const BOXES: readonly Flat[] = BOX_ROWS.flatMap((row) => [-4.5, -1.5, 1.5, 4.5].map((across) => onRoad(row, across)));

/** Boost pads, in the middle of the road. */
export const BOOSTS: readonly Flat[] = [
  [60, 100],
  [40, -15],
  [-75, -70],
  [-120, 45],
].map((pad) => onRoad(pad as Flat, 0));

/** The laps and bots the server takes. */
export const MAX_LAPS = 5;
export const MAX_RACERS = 8;
export const MAX_BOTS = 7;

/** The host's start: the gates, the grid, the boxes and pads as ground points, with the laps and bots chosen. */
export function trackLayout(laps: number, bots: number) {
  return {
    checkpoints: GATES.map(ground),
    radius: GATE_RADIUS,
    grid: GRID.map(ground),
    boxes: BOXES.map(ground),
    boosts: BOOSTS.map(ground),
    laps,
    bots,
  };
}

/** How long the middle line is, round the loop. */
export function lapLength(): number {
  return MIDDLE.reduce((sum, point, index) => {
    const next = MIDDLE[(index + 1) % MIDDLE.length]!;
    return sum + Math.hypot(next[0] - point[0], next[1] - point[1]);
  }, 0);
}

/** The heading (0 facing +z, a quarter turn facing +x) of a direction on the ground. */
export const headingOf = ([x, z]: Flat) => Math.atan2(x, z);
