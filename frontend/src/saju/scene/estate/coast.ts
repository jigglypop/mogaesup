import { noise2, rng } from '../noise';
import type { IslandShape } from '../terrain';

// The page's own 섬, made about four times as wide and deep as a neighbour's: an estate. Its waterline is not a rounded
// square but a coast, read round from the middle: a squarish round with the shore wandering a metre or two, headlands
// of rock running out, coves cut in (the harbour the jetty stands in, the mouth the stream runs out through, inlets
// behind), and a beach where the bank goes down into the water slowly. Each estate's coast wanders its own way; its
// features keep their places half way between the eight bearings where bridges land, so a bridge always comes to a
// plain bank. Every bearing crosses the waterline once, so a point's distance to it is reckoned from one radius.

const TAU = Math.PI * 2;
/** How finely the waterline is reckoned round: a sample every quarter of a degree. */
const SAMPLES = 1440;

/**
 * The estate's straight sides lie this far from its middle before the shore wanders: four neighbours' islands (5.5 m)
 * and a little more, so the coves cut into it still leave four neighbours' breadth of ground. One number: the zones,
 * paths and framing all follow it.
 */
export const ESTATE_HALF = 24;
/**
 * How large the page's own island is laid out (its half, as ESTATE_HALF's): the estate's places spread out by
 * HOME_HALF / ESTATE_HALF, so each thing keeps its size and the lawn between them grows, room for what the owner adds.
 */
export const HOME_HALF = 30;
/** Between a circle (2) and a square (large): a round that still has shoulders where the corners' bridges land. */
const ROUNDNESS = 2.5;
/** How far a bridge's foot reaches up the bank past the waterline (as village.ts reckons a bridge). */
export const BRIDGE_FOOT = 0.75;

/** `angle` brought into [-π, π). */
export const wrap = (angle: number) => angle - TAU * Math.floor((angle + Math.PI) / TAU);

/**
 * Bearings (radians from +x, the east, toward +z, the south) where bridges land, as homes.ts counts them: the east
 * first, then round through the south-east, the south and on.
 */
export const LANDINGS: readonly number[] = Array.from({ length: 8 }, (_, index) => wrap((index * TAU) / 8));

/**
 * `harbour` the cove the jetty stands in, `mouth` the cove the stream runs out through, `cove` an inlet, `point` a
 * headland of rock, `beach` sand going down slowly into the water.
 */
export type CoastKind = 'harbour' | 'mouth' | 'cove' | 'point' | 'beach';

/** A stretch of coast: what it is, the bearing of its middle, how far round it reaches to either side, and how far it moves the waterline out (or in). */
export type CoastFeature = { kind: CoastKind; bearing: number; half: number; depth: number };

/**
 * Every estate's coast, each feature half way between two landings. In front, as the untouched camera (from the
 * south-east) sees it: the mouth east-south-east, a small point by the near corner, the beach south-south-west by the
 * meadow; the harbour on the west; behind, a headland at each far corner and two inlets between them.
 */
const FEATURES: readonly CoastFeature[] = [
  { kind: 'mouth', bearing: Math.PI / 8, half: 0.11, depth: -2.4 },
  { kind: 'point', bearing: (3 * Math.PI) / 8, half: 0.12, depth: 1.4 },
  { kind: 'beach', bearing: (5 * Math.PI) / 8, half: 0.3, depth: 0.9 },
  { kind: 'harbour', bearing: (7 * Math.PI) / 8, half: 0.16, depth: -3.2 },
  { kind: 'point', bearing: (-7 * Math.PI) / 8, half: 0.16, depth: 2.4 },
  { kind: 'cove', bearing: (-5 * Math.PI) / 8, half: 0.12, depth: -1.8 },
  { kind: 'cove', bearing: (-3 * Math.PI) / 8, half: 0.1, depth: -1.2 },
  { kind: 'point', bearing: -Math.PI / 8, half: 0.15, depth: 2.2 },
];

/** 1 at a feature's middle, falling smoothly to 0 at `half` round from it. */
const window = (bearing: number, middle: number, half: number) => {
  const u = Math.abs(wrap(bearing - middle)) / half;
  return u >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * u);
};

/**
 * How the bank falls at a bearing, as distances across the shore from the waterline's line: the lawn stops `lawn`
 * metres inside it and the lake's bed is reached `bed` metres outside it. A rocky bank is today's island's (half a
 * metre and a metre and a half); a beach's sand runs nearly three metres up and its shelf seven out.
 */
export type Bank = { lawn: number; bed: number };
const ROCKY: Bank = { lawn: 0.5, bed: 1.5 };
const SANDY: Bank = { lawn: 2.8, bed: 7 };

/** The jetty: where its planks leave the bank, the bearing they run out along, and how long and wide it is. */
export type Jetty = { x: number; z: number; bearing: number; length: number; width: number };

/** A bridge's landing: its bearing, how far out the waterline lies there, and the bridge's foot on the bank. */
export type Landing = { index: number; bearing: number; radius: number; foot: [number, number] };

/** The estate's coast, the same for the same seed. */
export class Coast {
  readonly features: readonly CoastFeature[];
  /** The waterline's distance from the middle at each sample bearing, and how fast it changes round (metres a radian). */
  private readonly radii = new Float32Array(SAMPLES);
  private readonly slopes = new Float32Array(SAMPLES);
  /** The farthest and nearest the waterline runs from the middle. */
  readonly farthest: number;
  readonly nearest: number;
  /** How far from the middle the bank reaches the lake's bed at its farthest (the beach's shelf): what the ground is built out to. */
  readonly groundReach: number;
  /**
   * A rounded square about the coast for what still reckons an island as one (terrain's IslandShape, the lake's shore
   * model, the camera's frame): straight sides at the sides' own waterlines, corners as round as the coast's corners,
   * and its reach where the bank is lost under the water at the farthest point.
   */
  readonly hull: IslandShape;
  readonly jetty: Jetty;
  readonly landings: readonly Landing[];

  constructor(
    readonly seed: number,
    readonly half = ESTATE_HALF,
  ) {
    const random = rng(seed * 7 + 3);
    // Each coast's features shift a little round and run a little deeper or shallower than another's.
    this.features = FEATURES.map((feature) => ({ ...feature, bearing: feature.bearing + (random() - 0.5) * 0.08, depth: feature.depth * (0.82 + random() * 0.36) }));
    const s1 = (seed % 997) * 0.37 + 3.1;
    const s2 = (seed % 991) * 0.11 - 7.7;
    let farthest = 0;
    let nearest = Infinity;
    for (let index = 0; index < SAMPLES; index++) {
      const bearing = -Math.PI + (index * TAU) / SAMPLES;
      const cos = Math.cos(bearing);
      const sin = Math.sin(bearing);
      const base = half / (Math.abs(cos) ** ROUNDNESS + Math.abs(sin) ** ROUNDNESS) ** (1 / ROUNDNESS);
      // The shore wanders: broad swings of a metre or two, smaller bights within them. Read on the unit circle, so the
      // wander closes on itself all the way round.
      const wander = (noise2(cos * 1.6 + s1, sin * 1.6 + s2) - 0.5) * 2.4 + (noise2(cos * 4.6 + s2, sin * 4.6 - s1) - 0.5) * 1.0 + (noise2(cos * 12 - s1, sin * 12 + s2) - 0.5) * 0.36;
      let shaped = base + wander;
      for (const feature of this.features) shaped += feature.depth * window(bearing, feature.bearing, feature.half);
      this.radii[index] = shaped;
      farthest = Math.max(farthest, shaped);
      nearest = Math.min(nearest, shaped);
    }
    for (let index = 0; index < SAMPLES; index++) {
      const before = this.radii[(index + SAMPLES - 1) % SAMPLES]!;
      const after = this.radii[(index + 1) % SAMPLES]!;
      this.slopes[index] = (after - before) / ((2 * TAU) / SAMPLES);
    }
    this.farthest = farthest;
    this.nearest = nearest;
    let reach = 0;
    for (let index = 0; index < SAMPLES; index += 4) {
      const bearing = -Math.PI + (index * TAU) / SAMPLES;
      reach = Math.max(reach, this.radii[index]! + this.bank(bearing).bed);
    }
    this.groundReach = reach + 0.4;
    const side = (this.radius(0) + this.radius(Math.PI / 2) + this.radius(Math.PI) + this.radius(-Math.PI / 2)) / 4;
    const diagonal = LANDINGS.filter((_, index) => index % 2 === 1).reduce((sum, bearing) => sum + this.radius(bearing), 0) / 4;
    // A rounded square's corner of radius c lies (√2 − 1)·c in from the square's own corner along the diagonal.
    const round = Math.min(side, Math.max(1, (side * Math.SQRT2 - diagonal) / (Math.SQRT2 - 1)));
    this.hull = { half: side, corner: round, reach: farthest + 2 };
    const harbour = this.feature('harbour');
    // The planks leave the bank where the ground has come up to the lawn's height, and run out along the cove.
    const head = this.radius(harbour.bearing) - 0.7;
    this.jetty = { x: Math.cos(harbour.bearing) * head, z: Math.sin(harbour.bearing) * head, bearing: harbour.bearing, length: 5.4, width: 1.15 };
    this.landings = LANDINGS.map((bearing, index) => {
      const radius = this.radius(bearing);
      const foot = radius - BRIDGE_FOOT;
      return { index, bearing, radius, foot: [Math.cos(bearing) * foot, Math.sin(bearing) * foot] };
    });
  }

  private sample(table: Float32Array, bearing: number): number {
    const at = ((wrap(bearing) + Math.PI) / TAU) * SAMPLES;
    const index = Math.floor(at);
    const t = at - index;
    return table[index % SAMPLES]! * (1 - t) + table[(index + 1) % SAMPLES]! * t;
  }

  /** How far from the middle the waterline's line lies at `bearing` (radians from +x toward +z). */
  radius(bearing: number): number {
    return this.sample(this.radii, bearing);
  }

  /**
   * How far inside the waterline's line (x, z) lies, in metres; negative out in the water. Measured across the shore,
   * not along the bearing: where the coast turns sharply (a cove's sides) the bearing's distance is shortened by the turn.
   */
  inside(x: number, z: number): number {
    const bearing = Math.atan2(z, x);
    const radius = this.sample(this.radii, bearing);
    const turn = this.sample(this.slopes, bearing) / Math.max(radius, 1);
    return (radius - Math.hypot(x, z)) / Math.sqrt(1 + turn * turn);
  }

  /** How much the coast at `bearing` is the given kind of stretch: 1 in its middle, 0 away from it. */
  share(bearing: number, kind: CoastKind): number {
    let most = 0;
    for (const feature of this.features) if (feature.kind === kind) most = Math.max(most, window(bearing, feature.bearing, feature.half));
    return most;
  }

  /** The feature of `kind` (the first of them, for a kind there are several of). */
  feature(kind: CoastKind): CoastFeature {
    return this.features.find((feature) => feature.kind === kind)!;
  }

  /** How the bank falls at `bearing`: a rocky bank's, or a beach's where the beach is. */
  bank(bearing: number): Bank {
    const sand = this.share(bearing, 'beach');
    return { lawn: ROCKY.lawn + (SANDY.lawn - ROCKY.lawn) * sand, bed: ROCKY.bed + (SANDY.bed - ROCKY.bed) * sand };
  }

  /** The point `back` metres inland of the waterline's line at `bearing`. */
  at(bearing: number, back = 0): [number, number] {
    const radius = this.radius(bearing) - back;
    return [Math.cos(bearing) * radius, Math.sin(bearing) * radius];
  }

  /** The waterline's distance from the middle at every quarter degree round from the west (-π): what a shader reads it from. */
  table(): Float32Array {
    return this.radii.slice();
  }
}
