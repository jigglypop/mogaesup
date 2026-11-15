import type { Element } from '../../elements';
import type { PillarKey, Reading } from '../../engine';
import { MOTIFS, type MotifId } from '../../motifs';
import { islandPlanOf, STYLE_MOTIFS, type BedKind, type IslandPlan, type Placed, type TreeState } from '../../mulsang';
import { profileOfReading, type Profile } from '../../profile';
import { rng } from '../noise';
import { Coast, ESTATE_HALF, type Jetty, type Landing } from './coast';
import { boxOf, crossing, nearestOn, pointAlong, smoothLine, type V2 } from './lines';

// Where everything stands on a member's estate, worked out from their reading and its 물상 plan (mulsang): the same
// birth always gets the same estate, every spot in metres about the island's middle (x east, z south, the lawn at
// y = 0). The four pillars are read as 근묘화실 and laid from the back of the island to its front, as they grow toward
// the viewer (the untouched camera looks from the south-east):
//   년 뿌리: the land and its far edges. The wood along the back shore, the year's own thing behind the house, the
//            banks all round dressed as its branch says, and the spring the stream rises from.
//   월 싹:   the season and the garden. A fenced garden west of the house: four beds of the month stem's kind round a
//            crossing, the month's own thing in it, its trees in the month branch's season.
//   일 꽃:   the house and its yard at the heart. The house facing south, its 마당 in front, the guardian dog at the
//            door's right with room for what its 신살 gave it, the day master's emblem and the keepsake beside it, and
//            what the house's own style keeps about it.
//   시 열매: the orchard, the small lives and the pets' meadow. Fruit trees of the hour's kind in its season in the
//            near corner, the hour's thing beside the path, its creatures about, the meadow by the beach; without a
//            known hour, the orchard's ground is a plain meadow of wildflowers.
// Paths join the house to the four sides' landings, to a corner's where a bridge comes, and to each part; the stream
// runs from the spring past the house's east side to the mouth; places are kept open for what the owner sets out
// later. What is laid first keeps its place: paths, house and yard, water, the pillars' own things, and last what fills
// (trees, beds, bushes, stones), which give way to everything else.

/** The pillar whose part of the island a thing belongs to, or null for what all share (paths, the shore, open places). */
export type Part = PillarKey | null;

/** A tree as the estate plants it: its kind, how tall and how wide its crown. */
export type Species = 'zelkova' | 'maple' | 'persimmon' | 'fir' | 'pine' | 'birch' | 'willow' | 'bamboo' | 'ginkgo' | 'cypress';
export type TreeSpec = { species: Species; height: number; spread: number };

/** A fruit tree's kind (the plan's `fruitTree` variants, and the two that stand as motifs of their own). */
export type FruitKind = 'camellia' | 'plum' | 'cherry' | 'peach' | 'nankingCherry' | 'apricot' | 'grape' | 'persimmon' | 'citron' | 'mulberry' | 'pomegranate';

export type PlacementKind =
  /** The house, built by the houses builder about its own middle, facing +z. */
  | 'house'
  /** The guardian dog and its keepsakes (Guardian, scene/props/charms). */
  | 'guardian'
  /** The day master's emblem and the second element's keepsake (yard.ts). */
  | 'emblem'
  | 'keepsake'
  /** One of the motifs (motifs.ts): a pillar's, or the house style's own. */
  | 'motif'
  | 'tree'
  | 'fruitTree'
  | 'bush'
  /** A flower bed of the month stem's kind. */
  | 'bed'
  /** A drift of wildflowers in the season's colours. */
  | 'wildflowers'
  | 'rocks'
  | 'ferns'
  | 'reeds'
  | 'lamp'
  | 'bench'
  /** A small wooden bridge where a path crosses the stream. */
  | 'footbridge'
  | 'jetty'
  | 'boat'
  /** A pet's sleeping place in the meadow. */
  | 'nest'
  /** The pets' meadow itself: open grass ringed with flowers. */
  | 'meadow';

/** Who draws a placement: the estate's own builder, the houses builder, the guardian, or the motifs' builder. */
export type Drawer = 'estate' | 'house' | 'guardian' | 'motif';

export type Placement = {
  /** Unique in its estate: `year:pavilion`, `hour:orchard:3`, `path:lamp:main:1`. */
  id: string;
  kind: PlacementKind;
  part: Part;
  by: Drawer;
  /** Its foot on the ground. */
  at: V2;
  /** Radians about the vertical: 0 faces +z (the south), a quarter turn faces +x (the east). */
  facing: number;
  scale: number;
  /** What its own scatter is drawn by: the same for the same birth. */
  seed: number;
  /** How far about its foot it keeps the ground to itself, in metres. */
  reach: number;
  motif?: MotifId;
  variant?: string;
  state?: TreeState;
  /** A motif's Korean name (`곶감`, `석류나무`). */
  name?: string;
  /** Where on the house a house motif goes (`roof`, `front`, `eaves`). */
  on?: 'roof' | 'front' | 'eaves';
  tree?: TreeSpec;
  fruit?: FruitKind;
  bed?: BedKind;
  /** For a motif laid along something long (a wall, the stream): the line it follows. */
  along?: V2[];
};

/** How a path is laid: stepping stones in the house's stone, or earth trodden bare with a stone here and there. */
export type PathStyle = 'stones' | 'trodden';
export type EstatePath = { id: string; line: V2[]; width: number; style: PathStyle };

/** The stream: its course from the spring to the sea, and how wide its water is along it (at the spring and at the mouth). */
export type Stream = { line: V2[]; spring: V2; mouth: V2; width: [number, number] };
/** A pond: an oval hollow `rx` by `rz` about (x, z) that the lake's water stands in (terrain's Pond). */
export type EstatePond = { x: number; z: number; rx: number; rz: number };

/** A place kept open for what the owner sets out on their island later: nothing is planted or built there. */
export type DecorSlot = { id: string; at: V2; reach: number };

/** The house as the layout leaves room for it: its middle, the way it faces, its footprint about its middle, and its door. */
export type Footprint = { left: number; right: number; back: number; front: number };
export type HouseSlot = { at: V2; facing: number; footprint: Footprint; door: V2 };

/** A pillar's part of the island: where its name may be shown, and roughly what ground it holds. */
export type ZoneArea = { part: PillarKey; label: V2; box: { minX: number; maxX: number; minZ: number; maxZ: number } };

export type Estate = {
  seed: number;
  half: number;
  coast: Coast;
  plan: IslandPlan;
  profile: Pick<Profile, 'house' | 'guardian'>;
  house: HouseSlot;
  guardian: { at: V2; facing: number; reach: number };
  stream: Stream;
  ponds: EstatePond[];
  paths: EstatePath[];
  placements: Placement[];
  meadow: { at: V2; rx: number; rz: number; nests: V2[] };
  decor: DecorSlot[];
  jetty: Jetty;
  landings: readonly Landing[];
  zones: ZoneArea[];
  /** The ground kept bare: the yard, the house's own court or fire ring. Ovals `rx` by `rz` about (x, z). */
  bare: { x: number; z: number; rx: number; rz: number }[];
};

export type EstateOptions = {
  /** The house's footprint as the houses builder makes it; today's houses' by default. */
  footprint?: Footprint;
  /** The estate's half (see coast); ESTATE_HALF by default. */
  half?: number;
  /** The plan, when the caller has it already (with its own `taken` or `drawable`); else the reading's own. */
  plan?: IslandPlan;
  /**
   * The landings bridges come to (coast's LANDINGS order: 0 the east, 1 the south-east, … 7 the north-east). The four
   * sides' always have a path, which the house's own ways run on to; a corner's has one only when a bridge lands there.
   */
  bridges?: readonly number[];
};

/** Today's five houses, every side of them: the plinth, the porch and its steps in front, the chimney and the woodshed behind. */
export const TODAY_FOOTPRINT: Footprint = { left: 2.9, right: 2.95, back: 2.5, front: 3.45 };

/** A footprint from the box the houses builder gives a house (houses/design's Footprint: x and z about its foot). */
export const footprintOf = (box: { min: readonly [number, number]; max: readonly [number, number] }): Footprint => ({ left: -box.min[0], right: box.max[0], back: -box.min[1], front: box.max[1] });
/** The door's place along the house's front, from its middle (homes.ts DOOR_X). */
const DOOR_X = 1;
/** Where the house's middle stands on an estate of ESTATE_HALF: back from the island's middle, its yard in front. */
const HOUSE_AT: V2 = [0, -3];
/** How far apart the guardian's keepsakes need it to stand from anything: the dog and the furthest-reaching of them. */
const GUARDIAN_REACH = 1.55;
const QUARTER = Math.PI / 2;
const TAU = Math.PI * 2;

/** A number for one thing's scatter, from the estate's seed and the thing's name. */
function seedOf(seed: number, id: string): number {
  let h = 0x811c9dc5 ^ seed;
  for (let index = 0; index < id.length; index++) h = Math.imul(h ^ id.charCodeAt(index), 0x01000193);
  return ((h >>> 0) % 0xfffff) + 1;
}

/** A line taken from the ground, cut into its segments (from x, from z, to x, to z) with the box about them. */
type Taken = { half: number; segments: Float64Array; box: ReturnType<typeof boxOf> };

/** Whether (x, z) lies within `limit` of any segment of `taken`. */
function near(taken: Taken, x: number, z: number, limit: number): boolean {
  const { segments } = taken;
  for (let index = 0; index < segments.length; index += 4) {
    const ax = segments[index]!;
    const az = segments[index + 1]!;
    const bx = segments[index + 2]!;
    const bz = segments[index + 3]!;
    if (x < Math.min(ax, bx) - limit || x > Math.max(ax, bx) + limit || z < Math.min(az, bz) - limit || z > Math.max(az, bz) + limit) continue;
    const dx = bx - ax;
    const dz = bz - az;
    const span = dx * dx + dz * dz;
    const t = span > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / span)) : 0;
    const ex = x - ax - dx * t;
    const ez = z - az - dz * t;
    if (ex * ex + ez * ez < limit * limit) return true;
  }
  return false;
}

/** What the ground of an estate is taken by so far, for each new thing to keep clear of. */
class Ground {
  private readonly circles: { x: number; z: number; r: number }[] = [];
  private readonly lines: Taken[] = [];

  constructor(
    readonly coast: Coast,
    private readonly landings: readonly Landing[],
  ) {}

  take(x: number, z: number, r: number): void {
    this.circles.push({ x, z, r });
  }

  /** Something long: a path, the stream, a wall. */
  takeLine(line: V2[], half: number): void {
    const segments = new Float64Array(Math.max(0, line.length - 1) * 4);
    for (let index = 1; index < line.length; index++) segments.set([line[index - 1]![0], line[index - 1]![1], line[index]![0], line[index]![1]], (index - 1) * 4);
    this.lines.push({ half, segments, box: boxOf(line, half + 4) });
  }

  /**
   * Whether a thing reaching `r` about (x, z) is clear of the shore (`shore` metres in from the waterline at least), of
   * everything taken, and of the way a bridge comes up its bank.
   */
  free(x: number, z: number, r: number, shore = 1.2): boolean {
    if (this.coast.inside(x, z) < r + shore) return false;
    for (const circle of this.circles) {
      const dx = x - circle.x;
      const dz = z - circle.z;
      const apart = r + circle.r;
      if (dx * dx + dz * dz < apart * apart) return false;
    }
    for (const taken of this.lines) {
      const { box } = taken;
      if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
      if (near(taken, x, z, r + taken.half)) return false;
    }
    for (const landing of this.landings) {
      const cos = Math.cos(landing.bearing);
      const sin = Math.sin(landing.bearing);
      const out = x * cos + z * sin - (landing.radius - 3.4);
      if (out > -r && Math.abs(z * cos - x * sin) < 1.6 + r) return false;
    }
    return true;
  }

  /** The first free spot for a thing reaching `r` at `prefer` or near it, out to `range` metres away; null if there is none. */
  fit(prefer: V2, r: number, random: () => number, range = 4, shore = 1.2): V2 | null {
    if (this.free(prefer[0], prefer[1], r, shore)) return prefer;
    const start = random() * TAU;
    for (let away = 0.5; away <= range; away += 0.5) {
      const tries = Math.max(8, Math.round((away * TAU) / 0.8));
      for (let index = 0; index < tries; index++) {
        const angle = start + (index / tries) * TAU;
        const x = prefer[0] + Math.cos(angle) * away;
        const z = prefer[1] + Math.sin(angle) * away;
        if (this.free(x, z, r, shore)) return [x, z];
      }
    }
    return null;
  }
}

/** The species a year's 납음 element grows along the far shore, tallest first. */
const WOODS: Record<Element, readonly Species[]> = {
  wood: ['fir', 'zelkova', 'birch', 'fir', 'zelkova'],
  fire: ['maple', 'fir', 'maple', 'pine', 'zelkova'],
  earth: ['zelkova', 'persimmon', 'fir', 'zelkova', 'pine'],
  metal: ['pine', 'birch', 'cypress', 'birch', 'fir'],
  water: ['fir', 'birch', 'willow', 'fir', 'birch'],
};
/** How tall each grows along the far shore, and how wide. */
const GROWTH: Record<Species, { height: [number, number]; spread: [number, number] }> = {
  zelkova: { height: [4.6, 6.2], spread: [3.6, 4.6] },
  maple: { height: [4.0, 5.2], spread: [3.2, 4.0] },
  persimmon: { height: [3.6, 4.6], spread: [3.0, 3.6] },
  fir: { height: [5.2, 7.0], spread: [2.2, 2.8] },
  pine: { height: [4.2, 5.6], spread: [3.0, 3.8] },
  birch: { height: [4.2, 5.4], spread: [1.8, 2.3] },
  willow: { height: [4.0, 5.0], spread: [3.4, 4.0] },
  bamboo: { height: [3.6, 4.6], spread: [1.2, 1.6] },
  ginkgo: { height: [5.0, 6.4], spread: [3.0, 3.6] },
  cypress: { height: [4.4, 5.8], spread: [1.4, 1.8] },
};

/**
 * Where in the garden the month's motif stands: `back` along its north side (what grows tall or is built), `middle` at
 * its crossing (a centrepiece), `gate` over or at its east gate, `over` hung over the crossing.
 */
const GARDEN_FIT: Partial<Record<MotifId, 'back' | 'middle' | 'gate' | 'over'>> = {
  pomegranate: 'back',
  willow: 'back',
  pines: 'back',
  bamboo: 'back',
  saplings: 'back',
  mulberry: 'back',
  well: 'back',
  waterwheel: 'back',
  earthWall: 'back',
  rockHill: 'back',
  sunflowers: 'back',
  clothesline: 'back',
  forsythia: 'back',
  gate: 'gate',
  flowerArch: 'gate',
  stringLights: 'over',
  rainCloud: 'over',
};

/** Where on the yard the house style's own things stand, about the house's middle (see homes.ts, where each plan keeps them). */
type StyleSpot = 'yard' | 'behindWest' | 'behindEast' | 'sideEast' | 'house' | 'harbour' | 'path';
const STYLE_SPOTS: Record<StyleSpot, V2> = {
  yard: [-5.6, 5.6],
  behindWest: [-3.8, -6.0],
  behindEast: [3.9, -5.8],
  sideEast: [7.4, -3.4],
  house: [0, 0],
  harbour: [0, 0],
  path: [-1.9, 7.2],
};
const STYLE_SPOT_OF: Partial<Record<MotifId, StyleSpot>> = {
  woodpile: 'house',
  pots: 'house',
  gourds: 'house',
  jige: 'house',
  windChime: 'house',
  mushrooms: 'yard',
  bonfire: 'yard',
  stringLights: 'yard',
  clothesline: 'behindWest',
  jars: 'yard',
  stoneWall: 'behindWest',
  vegetableRows: 'behindEast',
  stoneLamp: 'path',
  birches: 'behindEast',
  pines: 'behindWest',
  bamboo: 'sideEast',
  pond: 'yard',
  well: 'behindEast',
  boat: 'harbour',
  willow: 'yard',
  irises: 'yard',
};

/** The colours and kinds of fruit tree an hour's corner motif asks for. */
function fruitOf(placed: Placed): FruitKind {
  if (placed.motif === 'mulberry' || placed.motif === 'pomegranate') return placed.motif;
  const variant = placed.variant as FruitKind | undefined;
  return variant ?? 'plum';
}

/** How far a motif reaches about its foot on an estate: its own reach, given a little more room on the larger ground. */
const reachOf = (motif: MotifId) => MOTIFS[motif].reach + 0.35;

/** Lays out the estate of `reading`. */
export function estateOf(reading: Reading, options: EstateOptions = {}): Estate {
  const plan = options.plan ?? islandPlanOf(reading);
  const profile = profileOfReading(reading);
  const half = options.half ?? ESTATE_HALF;
  const k = half / ESTATE_HALF;
  const seed = plan.seed;
  const coast = new Coast(seed, half);
  const ground = new Ground(coast, coast.landings);
  const placements: Placement[] = [];
  const random = rng(seed * 13 + 5);
  const at = (x: number, z: number): V2 => [x * k, z * k];

  const put = (placement: Omit<Placement, 'seed' | 'scale' | 'facing'> & Partial<Pick<Placement, 'seed' | 'scale' | 'facing'>>, take = true): Placement => {
    const full: Placement = { facing: 0, scale: 1, seed: seedOf(seed, placement.id), ...placement };
    placements.push(full);
    if (take) ground.take(full.at[0], full.at[1], full.reach);
    return full;
  };

  // 일: the house and its yard, first: everything else keeps clear of them.
  const footprint = options.footprint ?? TODAY_FOOTPRINT;
  const houseAt = at(HOUSE_AT[0], HOUSE_AT[1]);
  const door: V2 = [houseAt[0] + DOOR_X, houseAt[1] + footprint.front];
  const house: HouseSlot = { at: houseAt, facing: 0, footprint, door };
  const houseReach = Math.hypot(Math.max(footprint.left, footprint.right), Math.max(footprint.back, footprint.front)) * 0.82;
  put({ id: 'day:house', kind: 'house', part: 'day', by: 'house', at: houseAt, reach: houseReach }, false);
  ground.take(houseAt[0] - (footprint.left - footprint.right) / 2, houseAt[1] - (footprint.back - footprint.front) / 2, houseReach);
  const relative = (dx: number, dz: number): V2 => [houseAt[0] + dx, houseAt[1] + dz];
  const yard = relative(0.5, 5.6);
  const bare: Estate['bare'] = [{ x: yard[0], z: yard[1], rx: 4.6, rz: 2.7 }];
  const guardianAt = relative(3.3, 5.3);
  put({ id: 'day:guardian', kind: 'guardian', part: 'day', by: 'guardian', at: guardianAt, reach: GUARDIAN_REACH, facing: Math.PI / 4 });
  const emblemReach = profile.house.symbol === 'tree' ? 1.2 : 1.15;
  put({ id: 'day:emblem', kind: 'emblem', part: 'day', by: 'estate', at: relative(6.2, 1.1), reach: emblemReach });
  if (profile.house.accent) put({ id: 'day:keepsake', kind: 'keepsake', part: 'day', by: 'estate', at: relative(5.7, 7.4), reach: 0.7 });

  // The stream, from the spring at the back to the mouth in front, east of the house.
  const mouthFeature = coast.feature('mouth');
  const mouthOut = coast.at(mouthFeature.bearing, -1.4);
  const wobble = () => (random() - 0.5) * 1.2;
  const spring = at(9.5, -13.8);
  const streamLine = smoothLine(
    [spring, at(11.2 + wobble(), -9.5), at(10.0 + wobble(), -5.0), at(10.8 + wobble(), -0.6), at(12.6 + wobble(), 3.4), at(16.0, 6.2), coast.at(mouthFeature.bearing, 1.6), mouthOut],
    0.45,
  );
  const stream: Stream = { line: streamLine, spring, mouth: mouthOut, width: [0.7, 1.5] };
  ground.takeLine(streamLine, 1.05);

  // Paths: the skeleton the rest is laid between. Each spur ends on the path it joins.
  const paths: EstatePath[] = [];
  const foot = (index: number): V2 => coast.landings[index]!.foot;
  const addPath = (id: string, controls: V2[], width: number, style: PathStyle, onto?: EstatePath): EstatePath => {
    const points = [...controls];
    if (onto) points.push(nearestOn(onto.line, controls[controls.length - 1]![0], controls[controls.length - 1]![1]).at);
    const path: EstatePath = { id, line: smoothLine(points, 0.4), width, style };
    paths.push(path);
    ground.takeLine(path.line, width / 2 + 0.15);
    return path;
  };
  const main = addPath('main', [[door[0], door[1] + 0.2], at(0.8, 6.8), at(-0.7, 11.8), at(0.5, 16.6), foot(2)], 1.05, 'stones');
  // The east way leaves the yard behind the guardian, so the dog and what it keeps stand clear of it.
  const east = addPath('east', [relative(5.2, 3.2), at(7.4, 0.3), at(11.0, -0.4), at(15.4, -0.7), foot(0)], 0.8, 'trodden');
  const west = addPath('west', [relative(-3.7, 4.3), at(-7.0, 0.3), at(-12.5, -0.3), at(-18.2, -0.4), foot(4)], 0.8, 'trodden');
  const north = addPath('north', [relative(DOOR_X, -footprint.back - 0.2), at(0.8, -9.6), at(1.9, -15.0), at(0.7, -19.6), foot(6)], 0.75, 'trodden');
  const bridged = new Set(options.bridges ?? []);
  if (bridged.has(1)) addPath('southEast', [foot(1), at(13.6, 18.4), at(6.2, 17.8)], 0.7, 'trodden', main);
  if (bridged.has(3)) addPath('southWest', [foot(3), at(-13.6, 18.9), at(-5.4, 18.9)], 0.7, 'trodden', main);
  if (bridged.has(5)) addPath('northWest', [foot(5), at(-11.8, -15.8)], 0.7, 'trodden', north);
  if (bridged.has(7)) addPath('northEast', [foot(7), at(11.6, -17.2), at(4.6, -16.2)], 0.7, 'trodden', north);
  // A bridge's foot is kept clear even where no path meets it yet: a neighbour may come.
  const jetty = coast.jetty;
  addPath('jetty', [[jetty.x, jetty.z], at(-19.4, 5.6)], 0.7, 'trodden', west);
  // The garden's own way across it, north to south, crossing the west path at the garden's middle.
  const gardenAt = at(-12.5, -0.4);
  addPath('garden', [[gardenAt[0] + 0.2, gardenAt[1] - 4.7], [gardenAt[0], gardenAt[1]], [gardenAt[0] - 0.2, gardenAt[1] + 4.7]], 0.62, 'trodden');
  ground.take(jetty.x - Math.cos(jetty.bearing) * 0.4, jetty.z - Math.sin(jetty.bearing) * 0.4, 1.0);
  put({ id: 'shore:jetty', kind: 'jetty', part: null, by: 'estate', at: [jetty.x, jetty.z], reach: 0, facing: QUARTER - jetty.bearing }, false);

  // Where a path crosses the stream, a footbridge; lamps along the main path and at the crossings.
  for (const path of paths) {
    const meet = crossing(path.line, streamLine);
    if (!meet) continue;
    const heading = pointAlong(path.line, meet.alongA).heading;
    put({ id: `path:footbridge:${path.id}`, kind: 'footbridge', part: null, by: 'estate', at: meet.at, reach: 0, facing: QUARTER - heading, scale: path.width }, false);
  }
  for (const [index, share] of [0.2, 0.47, 0.74].entries()) {
    const { at: point, heading } = pointAlong(main.line, share);
    const side = index % 2 === 0 ? 1 : -1;
    const lamp: V2 = [point[0] - Math.sin(heading) * side * 1.0, point[1] + Math.cos(heading) * side * 1.0];
    put({ id: `path:lamp:main:${index}`, kind: 'lamp', part: null, by: 'estate', at: lamp, reach: 0.25 });
  }
  for (const [path, share] of [[east, 0.5], [west, 0.2], [north, 0.42]] as const) {
    const { at: point, heading } = pointAlong(path.line, share);
    put({ id: `path:lamp:${path.id}`, kind: 'lamp', part: null, by: 'estate', at: [point[0] - Math.sin(heading) * 0.9, point[1] + Math.cos(heading) * 0.9], reach: 0.25 });
  }

  // Places kept open for the owner: the first five that are free of what is laid so far.
  const decor: DecorSlot[] = [];
  for (const [index, spot] of [at(16.4, -7.4), at(-15.4, 9.4), at(-5.9, 8.6), at(6.0, -11.4), at(-14.2, -10.2), at(17.4, 12.4), at(-6.6, -18.2)].entries()) {
    if (decor.length === 5) break;
    if (!ground.free(spot[0], spot[1], 1.8, 2)) continue;
    decor.push({ id: `decor:${index}`, at: spot, reach: 1.8 });
    ground.take(spot[0], spot[1], 1.8);
  }

  // The house style's own things about the yard (mulsang STYLE_MOTIFS, as homes.ts keeps them).
  const ponds: EstatePond[] = [];
  const style = profile.house.style;
  for (const motif of STYLE_MOTIFS[style]) {
    const spot = STYLE_SPOT_OF[motif] ?? 'yard';
    const id = `day:style:${motif}`;
    if (spot === 'house') {
      put({ id, kind: 'motif', part: 'day', by: 'house', at: houseAt, reach: 0, motif, name: MOTIFS[motif].ko, on: 'front' }, false);
      continue;
    }
    if (spot === 'harbour') {
      const boatAt: V2 = [jetty.x + Math.cos(jetty.bearing) * (jetty.length - 0.6) - Math.sin(jetty.bearing) * 1.3, jetty.z + Math.sin(jetty.bearing) * (jetty.length - 0.6) + Math.cos(jetty.bearing) * 1.3];
      put({ id, kind: 'motif', part: 'day', by: 'motif', at: boatAt, reach: 0, motif, name: MOTIFS[motif].ko, facing: QUARTER - jetty.bearing }, false);
      continue;
    }
    if (motif === 'stoneWall') {
      // A wall round the back of the house, west of the path that leaves its back door.
      const line = smoothLine([relative(-6.6, -2.4), relative(-5.2, -6.4), relative(-1.0, -7.4)], 0.5);
      put({ id, kind: 'motif', part: 'day', by: 'motif', at: pointAlong(line, 0.5).at, reach: 0, motif, name: MOTIFS[motif].ko, along: line }, false);
      ground.takeLine(line, 0.55);
      continue;
    }
    const [dx, dz] = STYLE_SPOTS[spot];
    const reach = motif === 'pond' ? 2.2 : reachOf(motif);
    const placeAt = ground.fit(relative(dx, dz), reach, random, 3.5);
    if (!placeAt) continue;
    if (motif === 'pond') ponds.push({ x: placeAt[0], z: placeAt[1], rx: 1.8, rz: 1.35 });
    if (motif === 'bonfire' || motif === 'mushrooms') bare.push({ x: placeAt[0], z: placeAt[1], rx: reach * 0.9, rz: reach * 0.9 });
    put({ id, kind: 'motif', part: 'day', by: 'motif', at: placeAt, reach, motif, name: MOTIFS[motif].ko, facing: Math.atan2(yard[0] - placeAt[0], yard[1] - placeAt[1]) });
  }

  // The pillars' own things, as the plan places them.
  const garden = { at: gardenAt, half: [5.25, 5.0] as V2 };
  const orchard = { at: at(9.2, 12.0) };
  const meadowAt = at(-8.6, 13.6);
  for (const placed of plan.motifs) {
    const id = `${placed.pillar}:${placed.motif}${placed.variant ? `:${placed.variant}` : ''}`;
    const base = { id, kind: 'motif' as const, part: placed.pillar, by: 'motif' as const, motif: placed.motif, ...(placed.variant ? { variant: placed.variant } : {}), ...(placed.state ? { state: placed.state } : {}), name: placed.name, seed: placed.seed };
    if (placed.place === 'roof' || placed.place === 'front' || placed.place === 'eaves') {
      put({ ...base, by: 'house', at: houseAt, reach: 0, on: placed.place }, false);
      continue;
    }
    if (placed.place === 'corner') continue; // The orchard is the hour's corner, planted below.
    if (placed.place === 'life') {
      put({ ...base, at: placed.motif === 'ducks' ? coast.at(mouthFeature.bearing, -2.6) : placed.motif === 'dragonflies' ? pointAlong(streamLine, 0.62).at : placed.motif === 'chicks' ? meadowAt : orchard.at, reach: 0 }, false);
      continue;
    }
    if (placed.motif === 'brook') {
      put({ ...base, at: pointAlong(streamLine, 0.45).at, reach: 0, along: streamLine }, false);
      continue;
    }
    if (placed.motif === 'stoneWall' || placed.motif === 'earthWall' || placed.motif === 'forestEdge') {
      // Along the far shore behind the house, open where the north bridge lands.
      const from = -QUARTER - 0.62;
      const to = -QUARTER - 0.12;
      const back = placed.motif === 'forestEdge' ? 6.2 : 3.4;
      const line = smoothLine(Array.from({ length: 6 }, (_, index) => coast.at(from + ((to - from) * index) / 5, back)), 0.5);
      put({ ...base, at: pointAlong(line, 0.5).at, reach: 0, along: line }, false);
      ground.takeLine(line, placed.motif === 'forestEdge' ? 2.2 : 0.6);
      continue;
    }
    let prefer: V2;
    let facing = 0;
    if (placed.place === 'shore') {
      // On the stretch of coast that suits it: a boat at the harbour, sand on the beach, a shell or crystals on a point.
      const kind = placed.motif === 'boat' ? 'harbour' : placed.motif === 'sandbank' || placed.motif === 'goldSand' ? 'beach' : 'point';
      const feature = kind === 'point' ? coast.features.filter((item) => item.kind === 'point').sort((a, b) => Math.abs(wrapAngle(a.bearing - Math.PI / 4)) - Math.abs(wrapAngle(b.bearing - Math.PI / 4)))[0]! : coast.feature(kind);
      if (placed.motif === 'boat') {
        put({ ...base, at: [jetty.x + Math.cos(jetty.bearing) * (jetty.length - 0.6) - Math.sin(jetty.bearing) * 1.3, jetty.z + Math.sin(jetty.bearing) * (jetty.length - 0.6) + Math.cos(jetty.bearing) * 1.3], reach: 0, facing: QUARTER - jetty.bearing }, false);
        continue;
      }
      prefer = coast.at(feature.bearing, kind === 'beach' ? 1.6 : 1.9);
      facing = QUARTER - feature.bearing;
      const placeAt = ground.fit(prefer, reachOf(placed.motif) * 0.7, random, 3, 0.2);
      if (placeAt) put({ ...base, at: placeAt, reach: reachOf(placed.motif) * 0.7, facing });
      continue;
    }
    if (placed.pillar === 'year') {
      prefer = at(-4.6, -14.4);
      facing = Math.PI / 4;
    } else if (placed.pillar === 'month') {
      const fit = GARDEN_FIT[placed.motif] ?? 'middle';
      prefer = fit === 'back' ? [garden.at[0], garden.at[1] - 3.2] : fit === 'gate' ? [garden.at[0] + garden.half[0] - 0.2, garden.at[1] + 0.1] : garden.at;
      facing = fit === 'gate' ? QUARTER : Math.PI / 4;
      if (fit === 'over' || fit === 'gate') {
        // Over the crossing, or at the gate the west path goes through: these stand over a path, not off it.
        put({ ...base, at: prefer, reach: 0, facing }, false);
        continue;
      }
      if (placed.motif === 'pond') {
        const pondAt: V2 = [garden.at[0] - 2.3, garden.at[1] - 2.4];
        ponds.push({ x: pondAt[0], z: pondAt[1], rx: 1.7, rz: 1.3 });
        put({ ...base, at: pondAt, reach: 2.0, facing });
        continue;
      }
    } else {
      // The hour's thing by the path, on the west of it where the yard's light falls: what the pillars put by the path.
      const { at: point, heading } = pointAlong(main.line, 0.36);
      prefer = [point[0] + Math.sin(heading) * 1.9, point[1] - Math.cos(heading) * 1.9];
      facing = QUARTER - heading + Math.PI / 2;
    }
    const reach = reachOf(placed.motif);
    const placeAt = ground.fit(prefer, reach, random, placed.pillar === 'year' ? 6 : 3.5);
    if (placeAt) put({ ...base, at: placeAt, reach, facing });
  }

  // 시: the orchard of the hour's fruit in its season, or without an hour a meadow of wildflowers on its ground.
  const corner = plan.motifs.find((placed) => placed.place === 'corner');
  if (corner) {
    const fruit = fruitOf(corner);
    const rows = fruit === 'grape' ? 2 : 3;
    const spacing = fruit === 'grape' ? 2.6 : 3.4;
    let index = 0;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < 3; column++) {
        // In rows turned a little toward the camera, every other row set off by half a tree.
        const along = (column - 1 + (row % 2) * 0.5) * spacing;
        const across = (row - (rows - 1) / 2) * spacing;
        const turn = 0.22;
        const prefer: V2 = [orchard.at[0] + along * Math.cos(turn) - across * Math.sin(turn), orchard.at[1] + along * Math.sin(turn) + across * Math.cos(turn)];
        const placeAt = ground.fit(prefer, 1.1, random, 1.2);
        if (!placeAt) continue;
        put({ id: `hour:orchard:${index}`, kind: 'fruitTree', part: 'hour', by: 'estate', at: placeAt, reach: 1.1, fruit, ...(corner.state ? { state: corner.state } : {}), name: corner.name, scale: 0.86 + random() * 0.24, facing: random() * TAU });
        index += 1;
      }
    }
  } else {
    put({ id: 'hour:wildflowers', kind: 'wildflowers', part: 'hour', by: 'estate', at: orchard.at, reach: 3.2, scale: 3.2 });
  }

  // The meadow the pets keep to, down to the beach, and where they sleep.
  const meadow = { at: meadowAt, rx: 5.4 * k, rz: 4.0 * k, nests: [] as V2[] };
  for (const [index, [dx, dz]] of ([[-1.8, -0.9], [1.6, -1.4], [0.2, 1.5]] as const).entries()) {
    const nest: V2 = [meadowAt[0] + dx, meadowAt[1] + dz];
    meadow.nests.push(nest);
    put({ id: `hour:nest:${index}`, kind: 'nest', part: 'hour', by: 'estate', at: nest, reach: 0.4 }, false);
  }
  ground.take(meadowAt[0], meadowAt[1], Math.min(meadow.rx, meadow.rz));
  put({ id: 'hour:meadow', kind: 'meadow', part: 'hour', by: 'estate', at: meadowAt, reach: 0, scale: meadow.rx }, false);

  // 월: the garden. Four beds in the quarters its crossing leaves, of the month stem's kind; a fence about it; two
  // trees at its back. A bed gives way to the month's own thing where that stands in its quarter.
  for (const [index, [sx, sz]] of ([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).entries()) {
    const bedAt: V2 = [garden.at[0] + sx * 2.65, garden.at[1] + sz * 2.55];
    const reach = ground.free(bedAt[0], bedAt[1], 1.6, 1) ? 1.6 : ground.free(bedAt[0], bedAt[1], 1.15, 1) ? 1.15 : 0;
    if (!reach) continue;
    put({ id: `month:bed:${index}`, kind: 'bed', part: 'month', by: 'estate', at: bedAt, reach, bed: plan.beds, scale: reach / 1.3 });
  }
  for (const [index, [dx, dz]] of ([[-4.4, -4.3], [4.2, -4.6]] as const).entries()) {
    const placeAt = ground.fit([garden.at[0] + dx, garden.at[1] + dz], 1.3, random, 1.5);
    if (placeAt) put({ id: `month:tree:${index}`, kind: 'tree', part: 'month', by: 'estate', at: placeAt, reach: 1.3, tree: { species: index === 0 ? 'maple' : 'zelkova', height: 3.6 + random() * 0.6, spread: 2.8 + random() * 0.4 } });
  }
  put({ id: 'month:bench', kind: 'bench', part: 'month', by: 'estate', at: ground.fit([garden.at[0] + 4.2, garden.at[1] + 3.6], 0.6, random, 1.5) ?? [garden.at[0] + 4.2, garden.at[1] + 3.6], reach: 0.6, facing: -Math.PI * 0.75 });

  // 년: the wood along the far shore, tallest at the back, in rows staggered, gaps where the bridges land. In a wood
  // the crowns touch: each tree keeps only its trunk's ground to itself, and its crown may lean over a path.
  const yearElement = plan.pillars.year.ganji.nayin.element;
  const woods = WOODS[yearElement];
  let tree = 0;
  for (const [row, back] of [5.4, 8.6, 11.8].entries()) {
    const count = [17, 13, 7][row]!;
    const span = row === 2 ? Math.PI - 1.3 : Math.PI - 0.8;
    for (let index = 0; index < count; index++) {
      const bearing = -Math.PI / 2 - span / 2 + ((index + (row % 2 ? 0.5 : 0) + (random() - 0.5) * 0.5) / count) * span;
      const prefer = coast.at(bearing, back + (random() - 0.5) * 1.6);
      const species = woods[(index + row * 2) % woods.length]!;
      const growth = GROWTH[species];
      // Tallest along the shore, stepping down toward the house.
      const height = (growth.height[0] + (growth.height[1] - growth.height[0]) * random()) * [1, 0.86, 0.72][row]!;
      const spread = (growth.spread[0] + (growth.spread[1] - growth.spread[0]) * random()) * [1, 0.92, 0.82][row]!;
      if (!ground.free(prefer[0], prefer[1], 0.85, 1.6)) continue;
      put({ id: `year:wood:${tree++}`, kind: 'tree', part: 'year', by: 'estate', at: prefer, reach: 0.85, tree: { species, height, spread } });
    }
  }
  // Trees down the west and east shores, lower than the wood: the land's far edges at the sides.
  for (const [index, bearing] of [Math.PI - 0.64, Math.PI - 0.34, Math.PI + 0.3, 0.32, 0.62, -0.3].entries()) {
    const prefer = coast.at(bearing, 4.8 + random() * 1.8);
    const species = woods[(index + 1) % woods.length]!;
    const growth = GROWTH[species];
    if (!ground.free(prefer[0], prefer[1], 0.95, 1.6)) continue;
    put({ id: `year:side:${index}`, kind: 'tree', part: 'year', by: 'estate', at: prefer, reach: 0.95, tree: { species, height: growth.height[0] * 0.88, spread: growth.spread[0] * 0.95 } });
  }
  // The spring among stones and ferns, where the stream rises; willows and alders down its east bank.
  put({ id: 'year:spring', kind: 'rocks', part: 'year', by: 'estate', at: spring, reach: 0, scale: 1.1 }, false);
  for (const [index, share] of [0.18, 0.4, 0.64].entries()) {
    const { at: point, heading } = pointAlong(streamLine, share);
    const side = index === 1 ? -1 : 1;
    const prefer: V2 = [point[0] - Math.sin(heading) * side * 2.4, point[1] + Math.cos(heading) * side * 2.4];
    const placeAt = ground.fit(prefer, 1.0, random, 1.5);
    if (!placeAt) continue;
    const species: Species = index === 1 ? 'willow' : yearElement === 'metal' ? 'birch' : 'zelkova';
    const growth = GROWTH[species];
    put({ id: `year:bank:${index}`, kind: 'tree', part: 'year', by: 'estate', at: placeAt, reach: 1.0, tree: { species, height: growth.height[0] * 0.85, spread: growth.spread[0] * 0.9 } });
  }
  for (let index = 0; index < 9; index++) {
    const { at: point, heading } = pointAlong(streamLine, 0.08 + (index / 8) * 0.8);
    const side = index % 2 ? 1 : -1;
    const spot: V2 = [point[0] - Math.sin(heading) * side * 1.25, point[1] + Math.cos(heading) * side * 1.25];
    put({ id: `year:waterside:${index}`, kind: index % 3 === 0 ? 'reeds' : 'ferns', part: 'year', by: 'estate', at: spot, reach: 0, scale: 0.7 }, false);
  }

  // Bushes and stones along the paths and at the yard's corners, a few drifts of flowers, ferns where the wood is.
  for (const [index, [dx, dz]] of ([[-4.4, 2.4], [4.6, 3.1], [-3.6, 8.3], [3.1, 8.6]] as const).entries()) {
    const placeAt = ground.fit(relative(dx, dz), 0.6, random, 1.2);
    if (placeAt) put({ id: `day:bush:${index}`, kind: 'bush', part: 'day', by: 'estate', at: placeAt, reach: 0.6, scale: 0.5 + random() * 0.2 });
  }
  for (const path of paths) {
    const steps = Math.floor(path.line.length / 9);
    for (let step = 1; step < steps; step++) {
      if (random() > 0.55) continue;
      const { at: point, heading } = pointAlong(path.line, step / steps);
      const side = random() < 0.5 ? 1 : -1;
      const away = path.width / 2 + 0.9;
      const spot: V2 = [point[0] - Math.sin(heading) * side * away, point[1] + Math.cos(heading) * side * away];
      if (!ground.free(spot[0], spot[1], 0.55, 1.4)) continue;
      const kind: PlacementKind = random() < 0.62 ? 'bush' : 'rocks';
      put({ id: `path:${kind}:${path.id}:${step}`, kind, part: null, by: 'estate', at: spot, reach: 0.55, scale: 0.45 + random() * 0.25 });
    }
  }
  // The open lawns between the parts: a lone tree with a bench in its shade, shrubs in threes, drifts of flowers.
  const lone: V2[] = [at(15.8, 3.2), at(-17.0, 12.2), at(14.2, -10.4), at(-3.2, -11.4), at(6.4, 20.0), at(-16.4, -13.8)];
  for (const [index, spot] of lone.entries()) {
    const placeAt = ground.fit(spot, 1.3, random, 2.2, 2);
    if (!placeAt) continue;
    const species: Species = (['zelkova', 'maple', 'pine', 'zelkova', 'birch', 'pine'] as const)[index]!;
    const growth = GROWTH[species];
    put({ id: `year:lone:${index}`, kind: 'tree', part: 'year', by: 'estate', at: placeAt, reach: 1.3, tree: { species, height: growth.height[0], spread: growth.spread[0] } });
    if (index === 0) {
      const seat = ground.fit([placeAt[0] - 1.4, placeAt[1] + 1.2], 0.55, random, 1.2);
      if (seat) put({ id: 'year:lone:bench', kind: 'bench', part: 'year', by: 'estate', at: seat, reach: 0.55, facing: Math.PI / 4 });
    }
  }
  for (const [index, spot] of [at(18.2, -3.6), at(-9.6, 7.2), at(-19.0, 6.4), at(4.6, -14.6), at(12.6, 7.4), at(-6.0, -6.8)].entries()) {
    for (let shrub = 0; shrub < 3; shrub++) {
      const placeAt = ground.fit([spot[0] + (shrub - 1) * 0.9, spot[1] + (shrub % 2) * 0.6], 0.55, random, 1.4);
      if (placeAt) put({ id: `year:shrubs:${index}:${shrub}`, kind: 'bush', part: 'year', by: 'estate', at: placeAt, reach: 0.55, scale: 0.42 + random() * 0.2 });
    }
  }
  // Flowers along the first stretch of the main path out of the yard, and drifts of them on the open lawns.
  for (const share of [0.09, 0.17, 0.25, 0.33]) {
    const { at: point, heading } = pointAlong(main.line, share);
    for (const side of [-1, 1]) {
      const spot: V2 = [point[0] - Math.sin(heading) * side * 1.25, point[1] + Math.cos(heading) * side * 1.25];
      if (!ground.free(spot[0], spot[1], 0.5, 1.5)) continue;
      put({ id: `day:border:${share}:${side}`, kind: 'wildflowers', part: 'day', by: 'estate', at: spot, reach: 0.5, scale: 0.6 });
    }
  }
  for (const [index, spot] of [at(17.4, 6.8), at(-12.6, 8.2), at(8.2, -6.0), at(-19.4, -4.6), at(10.4, 19.4), at(-4.2, 20.2), at(16.6, -15.4), at(-9.0, -9.6)].entries()) {
    const placeAt = ground.fit(spot, 1.1, random, 1.6, 1.8);
    if (placeAt) put({ id: `year:drift:${index}`, kind: 'wildflowers', part: 'year', by: 'estate', at: placeAt, reach: 1.1, scale: 1.1 + random() * 0.4 });
  }
  // The rim: low shrubs and stones along the top of the bank all round, broken where bridges land and on the beach.
  for (let index = 0; index < 36; index++) {
    const bearing = -Math.PI + ((index + random() * 0.6) / 36) * TAU;
    if (coast.share(bearing, 'beach') > 0.05) continue;
    const spot = coast.at(bearing, 2.3 + random() * 1.3);
    if (!ground.free(spot[0], spot[1], 0.5, 1.3)) continue;
    const kind: PlacementKind = random() < 0.68 ? 'bush' : 'rocks';
    put({ id: `shore:rim:${index}`, kind, part: 'year', by: 'estate', at: spot, reach: 0.5, scale: 0.38 + random() * 0.22 });
  }
  for (let index = 0; index < 16; index++) {
    const bearing = -Math.PI + random() * TAU;
    const spot = coast.at(bearing, 3.0 + random() * 6);
    if (!ground.free(spot[0], spot[1], 1.0, 1.6)) continue;
    put({ id: `shore:wildflowers:${index}`, kind: 'wildflowers', part: 'year', by: 'estate', at: spot, reach: 1.0, scale: 1.0 + random() * 0.6 });
  }
  for (let index = 0; index < 8; index++) {
    const bearing = -Math.PI + 0.5 + random() * (Math.PI - 1);
    const spot = coast.at(bearing, 3.4 + random() * 3.2);
    if (!ground.free(spot[0], spot[1], 0.6, 1.4)) continue;
    put({ id: `year:ferns:${index}`, kind: 'ferns', part: 'year', by: 'estate', at: spot, reach: 0.6 });
  }
  // Reeds where the stream comes out, and in the inlets.
  put({ id: 'shore:reeds:mouth', kind: 'reeds', part: null, by: 'estate', at: coast.at(mouthFeature.bearing, 0.1), reach: 0, scale: 1.3 }, false);
  for (const [index, feature] of coast.features.filter((item) => item.kind === 'cove').entries()) put({ id: `shore:reeds:cove:${index}`, kind: 'reeds', part: null, by: 'estate', at: coast.at(feature.bearing, 0.1), reach: 0, scale: 1 }, false);

  const zones: ZoneArea[] = [
    { part: 'year', label: at(-4.6, -14.4), box: { minX: -half, maxX: half, minZ: -half * 1.1, maxZ: -9 * k } },
    { part: 'month', label: garden.at, box: { minX: garden.at[0] - garden.half[0], maxX: garden.at[0] + garden.half[0], minZ: garden.at[1] - garden.half[1], maxZ: garden.at[1] + garden.half[1] } },
    { part: 'day', label: [houseAt[0], houseAt[1] + 1], box: { minX: houseAt[0] - 7, maxX: houseAt[0] + 8, minZ: houseAt[1] - 6, maxZ: houseAt[1] + 10 } },
  ];
  zones.push({ part: 'hour', label: corner ? orchard.at : meadowAt, box: { minX: -half, maxX: half, minZ: 7.5 * k, maxZ: half * 1.1 } });

  return {
    seed,
    half,
    coast,
    plan,
    profile: { house: profile.house, guardian: profile.guardian },
    house,
    guardian: { at: guardianAt, facing: Math.PI / 4, reach: GUARDIAN_REACH },
    stream,
    ponds,
    paths,
    placements,
    meadow,
    decor,
    jetty,
    landings: coast.landings,
    zones,
    bare,
  };
}

const wrapAngle = (angle: number) => angle - TAU * Math.floor((angle + Math.PI) / TAU);

/** The pillar whose part of the estate (x, z) lies in, or null on what all share. */
export function partAt(estate: Estate, x: number, z: number): Part {
  for (const zone of [estate.zones[2]!, estate.zones[1]!, estate.zones[3]!, estate.zones[0]!]) {
    const { box } = zone;
    if (x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ) return zone.part;
  }
  return null;
}

/** Every placement of `kind`. */
export const placementsOf = (estate: Estate, kind: PlacementKind) => estate.placements.filter((placement) => placement.kind === kind);
