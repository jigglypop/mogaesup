import { Color } from 'three';

import type { Terrain } from '../../api/types';
import type { Element } from '../elements';
import type { Reading } from '../engine';
import type { Season } from '../mulsang';
import { BRIDGE_FOOT, Coast, LANDINGS, type Jetty, type Landing } from './estate/coast';
import { seasonPaint } from './estate/draw';
import type { GroundPaint } from './estate/ground';
import { estateOf, type Estate, type EstatePath, type Placement } from './estate/layout';
import { lengthOf, nearestOn, pointAlong, type V2 } from './estate/lines';
import { groundOf } from './homes';
import { noise2 } from './noise';
import { ISLANDS, shoreAt, type IslandShape } from './terrain';

// The page's own island as an estate (see estate/): four neighbours' islands across each way, laid out from the
// member's reading. The estate's coast, with its coves and headlands, waits for the lake to learn it: the lake reckons
// every island a rounded square (ocean/shore), so until it reads an estate's own shore the estate is laid on the
// rounded square the lake knows, ISLANDS.home, and the waves break on the island's real shore. Its stretches keep their
// character (the beach's sand, the headlands' big stones, the harbour and the stream's mouth clear of stones); what the
// layout set by the coast's own line (the jetty, the stream's mouth and the reeds and ducks there, a motif on a point or
// the beach, the rim along the bank) is brought to the square's waterline, and what it left too near the water is moved
// in or left out.

const TAU = Math.PI * 2;
const QUARTER = Math.PI / 2;
/** How finely the square's waterline is read round for its farthest and nearest: every quarter of a degree. */
const SAMPLES = 1440;
/** How far a bridge's foot may lie from a way's end for the way to be the one that runs to it. */
const ON_FOOT = 0.6;
/** How far in from the waterline the firm ground begins, and how much of its own reach a thing keeps from the bank. */
const FIRM = 0.9;
const KEEP = 0.6;
/** What fills the ground and is simply left out where the square's bank comes too near: the rest is moved in. */
const FILL = new Set<Placement['kind']>(['tree', 'bush', 'rocks', 'ferns', 'wildflowers', 'fruitTree']);
/** Motifs that stand on the shore itself: on a point, or on the beach. */
const ON_SHORE = new Set(['pearlShell', 'crystals', 'sandbank', 'goldSand']);

/**
 * An estate's coast laid on a rounded square: the waterline runs round `shape`, wandering half a metre either way as
 * every island's does, and the stretches the estate's own coast has (its beach, headlands, harbour and mouth) keep their
 * bearings, so the ground is painted and dressed as they are.
 */
export class SquareCoast extends Coast {
  override readonly farthest: number = 0;
  override readonly nearest: number = 0;
  override readonly groundReach: number = 0;
  override readonly hull: IslandShape = ISLANDS.home;
  override readonly jetty: Jetty = { x: 0, z: 0, bearing: 0, length: 0, width: 0 };
  override readonly landings: readonly Landing[] = [];
  /** Unset while the coast's own constructor runs: it asks for radii before this one has a shape, and is answered from its own table. */
  private readonly shape: IslandShape | undefined;
  private readonly salt: [number, number] = [0, 0];

  constructor(own: Coast, shape: IslandShape = ISLANDS.home) {
    super(own.seed, own.half);
    this.shape = shape;
    this.hull = shape;
    this.salt = [(own.seed % 997) * 0.53 + 1.7, (own.seed % 991) * 0.29 - 4.1];
    let farthest = 0;
    let nearest = Infinity;
    let reach = 0;
    for (let index = 0; index < SAMPLES; index++) {
      const bearing = -Math.PI + (index * TAU) / SAMPLES;
      const radius = this.radius(bearing);
      farthest = Math.max(farthest, radius);
      nearest = Math.min(nearest, radius);
      if (index % 4 === 0) reach = Math.max(reach, radius + this.bank(bearing).bed);
    }
    this.farthest = farthest;
    this.nearest = nearest;
    this.groundReach = reach + 0.4;
    // The jetty keeps the harbour's bearing; its planks leave the bank where the ground has come up to the lawn's height.
    const harbour = own.jetty.bearing;
    const head = this.radius(harbour) - 0.7;
    this.jetty = { ...own.jetty, x: Math.cos(harbour) * head, z: Math.sin(harbour) * head };
    this.landings = LANDINGS.map((bearing, index) => {
      const radius = this.radius(bearing);
      const foot = radius - BRIDGE_FOOT;
      return { index, bearing, radius, foot: [Math.cos(bearing) * foot, Math.sin(bearing) * foot] };
    });
  }

  /** How far the waterline wanders from the square at `bearing`: as on any island, its bights a shore's metres apart. */
  private wander(bearing: number): number {
    const cos = Math.cos(bearing);
    const sin = Math.sin(bearing);
    const [s1, s2] = this.salt;
    return (noise2(cos * 6.6 + s1, sin * 6.6 + s2) - 0.5) * 0.7 + (noise2(cos * 17 + s2, sin * 17 - s1) - 0.5) * 0.24;
  }

  override radius(bearing: number): number {
    if (!this.shape) return super.radius(bearing);
    return shoreAt(this.shape, bearing) + this.wander(bearing);
  }

  override inside(x: number, z: number): number {
    if (!this.shape) return super.inside(x, z);
    const { half, corner } = this.shape;
    const qx = Math.abs(x) - (half - corner);
    const qz = Math.abs(z) - (half - corner);
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - corner;
    return this.wander(Math.atan2(z, x)) - outside;
  }

  override table(): Float32Array {
    return Float32Array.from({ length: SAMPLES }, (_, index) => this.radius(-Math.PI + (index * TAU) / SAMPLES));
  }
}

const bearingOf = ([x, z]: V2) => Math.atan2(z, x);

/** The way `path` with its ends brought from the estate's own landings to the square's, and the jetty's to its jetty. */
function wayOf(path: EstatePath, own: Coast, coast: SquareCoast): EstatePath {
  const line = path.line.map(([x, z]): V2 => [x, z]);
  for (const end of [0, line.length - 1]) {
    const [x, z] = line[end]!;
    const landing = own.landings.findIndex((item) => Math.hypot(item.foot[0] - x, item.foot[1] - z) < ON_FOOT);
    if (landing >= 0) line[end] = [...coast.landings[landing]!.foot];
    else if (path.id === 'jetty' && Math.hypot(own.jetty.x - x, own.jetty.z - z) < ON_FOOT) line[end] = [coast.jetty.x, coast.jetty.z];
  }
  return { ...path, line };
}

/** Where a boat lies beside the jetty's far end. */
const boatBy = (jetty: Jetty): V2 => [
  jetty.x + Math.cos(jetty.bearing) * (jetty.length - 0.6) - Math.sin(jetty.bearing) * 1.3,
  jetty.z + Math.sin(jetty.bearing) * (jetty.length - 0.6) + Math.cos(jetty.bearing) * 1.3,
];

/** `estate` laid on the rounded square `shape` (see {@link SquareCoast}): the same places, its shore the lake's. */
export function onSquare(estate: Estate, shape: IslandShape = ISLANDS.home): Estate {
  const own = estate.coast;
  const coast = new SquareCoast(own, shape);
  const mouth = own.feature('mouth').bearing;
  const shoreMotif = new Set(estate.plan.motifs.filter((placed) => placed.place === 'shore').map((placed) => `${placed.pillar}:${placed.motif}${placed.variant ? `:${placed.variant}` : ''}`));
  /** `point` moved along its bearing to lie `back` in from the square's waterline, if it lies nearer the water than that. */
  const inland = (point: V2, back: number): V2 => (coast.inside(point[0], point[1]) >= back ? point : coast.at(bearingOf(point), back));
  const placements = estate.placements.flatMap((placement): Placement[] => {
    const { id, kind, motif } = placement;
    if (kind === 'jetty') return [{ ...placement, at: [coast.jetty.x, coast.jetty.z], facing: QUARTER - coast.jetty.bearing }];
    if (motif === 'boat') return [{ ...placement, at: boatBy(coast.jetty), facing: QUARTER - coast.jetty.bearing }];
    if (motif === 'ducks') return [{ ...placement, at: coast.at(mouth, -2.6) }];
    // Reeds by the shore stand in its shallows; those by the stream stay by the stream.
    if (kind === 'reeds' && id.startsWith('shore:')) return [{ ...placement, at: coast.at(bearingOf(placement.at), 0.1) }];
    if (kind === 'motif' && motif && (shoreMotif.has(id) || ON_SHORE.has(motif))) return [{ ...placement, at: coast.at(bearingOf(placement.at), 1.9) }];
    const along = placement.along?.map((point) => inland(point, FIRM + 0.5));
    const room = FIRM + placement.reach * KEEP;
    if (placement.reach > 0 && coast.inside(placement.at[0], placement.at[1]) < room) {
      if (FILL.has(kind)) return [];
      return [{ ...placement, at: inland(placement.at, room), ...(along ? { along } : {}) }];
    }
    return [along ? { ...placement, along } : placement];
  });
  // The stream runs on from where the estate's mouth was, straight out through the square's bank into the lake.
  const line = [...estate.stream.line, coast.at(mouth, -0.4), coast.at(mouth, -1.8)];
  const stream = { ...estate.stream, line, mouth: line[line.length - 1]! };
  const paths = estate.paths.map((path) => wayOf(path, own, coast));
  return { ...estate, coast, jetty: coast.jetty, landings: coast.landings, stream, paths, placements: [...placements, ...pathLamps(paths, stream, estate.ponds, placements, coast)] };
}

/** How far apart lamps stand along a way, how far in from its ends the first and last stand, and from anything else. */
const LAMP_EVERY = 6.5;
const LAMP_IN = 2.5;
const LAMP_CLEAR = 0.35;

/**
 * Lamps along the estate's ways, one side and then the other, every {@link LAMP_EVERY} metres: an estate is many
 * islands' breadth of ground, and after dark a few lamps by the house leave the rest of it a dark mass. A lamp keeps off
 * the ways, the stream and the ponds, clear of what stands and of the lamps already there, and in from the bank.
 */
export function pathLamps(paths: readonly EstatePath[], stream: Estate['stream'], ponds: Estate['ponds'], placements: readonly Placement[], coast: Coast): Placement[] {
  const lamps: Placement[] = [];
  const lit = placements.filter((placement) => placement.kind === 'lamp').map((placement) => placement.at);
  const clear = (x: number, z: number): boolean => {
    if (coast.inside(x, z) < 1.6) return false;
    if (paths.some((path) => nearestOn(path.line, x, z).distance < path.width / 2 + LAMP_CLEAR)) return false;
    if (nearestOn(stream.line, x, z).distance < stream.width[1] / 2 + 0.6) return false;
    if (ponds.some((pond) => Math.hypot((x - pond.x) / (pond.rx + 0.6), (z - pond.z) / (pond.rz + 0.6)) < 1)) return false;
    if (placements.some((placement) => placement.reach > 0 && Math.hypot(placement.at[0] - x, placement.at[1] - z) < placement.reach + LAMP_CLEAR)) return false;
    return [...lit, ...lamps.map((lamp) => lamp.at)].every(([lx, lz]) => Math.hypot(lx - x, lz - z) > LAMP_EVERY * 0.6);
  };
  for (const path of paths) {
    const length = lengthOf(path.line);
    const count = Math.floor((length - 2 * LAMP_IN) / LAMP_EVERY) + 1;
    for (let index = 0; index < count; index++) {
      const { at, heading } = pointAlong(path.line, (LAMP_IN + index * LAMP_EVERY) / length);
      for (const side of index % 2 ? [1, -1] : [-1, 1]) {
        const away = path.width / 2 + 0.55;
        const x = at[0] - Math.sin(heading) * side * away;
        const z = at[1] + Math.cos(heading) * side * away;
        if (!clear(x, z)) continue;
        lamps.push({ id: `path:lamp:${path.id}:more:${index}`, kind: 'lamp', part: null, by: 'estate', at: [x, z], facing: 0, scale: 1, seed: index + 1, reach: 0.25 });
        break;
      }
    }
  }
  return lamps;
}

/**
 * How much of the house's own green the estate's lawn keeps against its month's grass: an autumn's or a winter's grass
 * alone, over the breadth of an estate, reads from afar as bare earth; a spring's or a summer's is green of itself.
 */
const KEEP_GREEN: Record<Season['key'], number> = { spring: 0.3, summer: 0.25, autumn: 0.82, winter: 0.7 };

/** The ground of each terrain an owner may lay: over the whole island, or cell by cell (estate/painted). */
export const TERRAIN_GROUND: Readonly<Record<Exclude<Terrain, 'default'>, GroundPaint>> = {
  snow: {
    surface: 'snow', lawn: ['#d6e7f2', '#f1f7fc', '#c6daeb'], dirt: '#abc1cc', yard: '#cdd7d9', path: '#8f9fad',
    stones: '#9fadc0', bank: '#929ca8', sand: '#d2dce0', bed: '#253e50', cover: 0,
  },
  desert: {
    surface: 'desert', lawn: ['#e4b777', '#f8d49a', '#c8955d'], dirt: '#bf8c55', yard: '#ca945e', path: '#ac7149',
    stones: '#b28e68', bank: '#bb8d67', sand: '#f2d399', bed: '#4d483c', cover: 0,
  },
  moss: {
    surface: 'moss', lawn: ['#447158', '#729147', '#9dba63'], dirt: '#5e6241', yard: '#979164', path: '#8d8468',
    stones: '#889382', bank: '#6b756b', sand: '#b9b18e', bed: '#244238', cover: 0,
  },
};

/** The estate's ground in its month's season, kept as green as the house's own lawn (see {@link KEEP_GREEN}). */
export function lawnOf(estate: Estate, style: Element, terrain: Terrain = 'default'): GroundPaint {
  if (terrain !== 'default') return TERRAIN_GROUND[terrain];
  const season = seasonPaint(estate);
  const share = KEEP_GREEN[estate.plan.season.key];
  const keep = (hex: string, green: string) => `#${new Color(hex).lerp(new Color(green), share).getHexString()}`;
  const lawn = groundOf(style).lawn;
  const [body, patches, flecks] = season.lawn;
  return { ...season, lawn: [keep(body, lawn[0]), keep(patches, lawn[1]), keep(flecks, lawn[2])] };
}

/**
 * The bridges' landings on the page's own island, in the estate's order (0 the east, 1 the south-east … 7 the north-east),
 * for neighbours at `spots` about it: the corners a bridge comes to are given a way of their own.
 */
export function landingsOf(spots: readonly { x: number; z: number }[]): number[] {
  const found = new Set<number>();
  for (const { x, z } of spots) {
    if (x === 0 && z === 0) continue;
    found.add((((Math.round(Math.atan2(z, x) / (Math.PI / 4)) % 8) + 8) % 8));
  }
  return [...found].sort((a, b) => a - b);
}

/** The page's own island for `reading`: its estate, laid on the rounded square the lake knows. */
export function estateHomeOf(reading: Reading, bridges: readonly number[] = [1, 3, 5, 7]): Estate {
  return onSquare(estateOf(reading, { bridges }));
}
