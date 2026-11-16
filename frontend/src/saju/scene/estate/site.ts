import { WATER_LEVEL } from '../mood';
import { noise2 } from '../noise';
import { Site } from '../terrain';
import type { Estate, EstatePath } from './layout';
import { boxOf, type V2 } from './lines';

// An estate's ground: the lawn at y = 0, the bank falling from it to the lake's bed as the coast says (a rocky bank's
// two metres, a beach's ten), the stream's bed and the ponds' hollows dipping below the lake's level so the lake's own
// water stands in them. It is terrain's Site with the estate's coast in place of the rounded square, so whatever reads
// an island's ground (the lawn, the shore's dressing, the pets) reads an estate's the same way.

const smooth = (from: number, to: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/** A line cut into segments, with how far along the line each begins and the box about them all. */
type Course = { segments: Float64Array; starts: Float64Array; total: number; box: ReturnType<typeof boxOf> };

function courseOf(line: readonly V2[], margin: number): Course {
  const segments = new Float64Array(Math.max(0, line.length - 1) * 4);
  const starts = new Float64Array(Math.max(0, line.length - 1));
  let walked = 0;
  for (let index = 1; index < line.length; index++) {
    const [ax, az] = line[index - 1]!;
    const [bx, bz] = line[index]!;
    segments.set([ax, az, bx, bz], (index - 1) * 4);
    starts[index - 1] = walked;
    walked += Math.hypot(bx - ax, bz - az);
  }
  return { segments, starts, total: walked || 1, box: boxOf(line, margin) };
}

/** The nearest distance from (x, z) to a course within `limit`, and the share along it there; null when farther. */
function nearCourse(course: Course, x: number, z: number, limit: number): { distance: number; along: number } | null {
  const { box, segments, starts } = course;
  if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) return null;
  let best = limit * limit;
  let along = -1;
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
    const squared = ex * ex + ez * ez;
    if (squared < best) {
      best = squared;
      along = (starts[index / 4]! + Math.sqrt(span) * t) / course.total;
    }
  }
  return along < 0 ? null : { distance: Math.sqrt(best), along };
}

export class EstateSite extends Site {
  private readonly stream: Course;
  private readonly trails: { course: Course; half: number; stones: boolean }[];
  /** The spring's own pool at the stream's head. */
  private readonly head: { x: number; z: number; r: number };

  constructor(readonly estate: Estate) {
    super(estate.seed, estate.ponds, estate.coast.hull);
    this.stream = courseOf(estate.stream.line, estate.stream.width[1] * 1.6 + 1);
    this.trails = estate.paths.map((path: EstatePath) => ({ course: courseOf(path.line, path.width), half: path.width / 2, stones: path.style === 'stones' }));
    this.head = { x: estate.stream.spring[0], z: estate.stream.spring[1], r: 0.95 };
    for (const { x, z, rx, rz } of estate.bare) this.bare(x, z, rx, rz);
  }

  /** How far inside the waterline's line (x, z) lies, in metres; negative out in the lake. */
  override shore(x: number, z: number): number {
    return this.estate.coast.inside(x, z);
  }

  /** How far into the stream's water (x, z) lies: 1 on its line, 0 at its edge, less outside (as far into a pond). */
  streamAt(x: number, z: number): number {
    const [narrow, wide] = this.estate.stream.width;
    const near = nearCourse(this.stream, x, z, wide * 1.6 + 1);
    const pool = 1 - Math.hypot(x - this.head.x, z - this.head.z) / this.head.r;
    if (!near) return Math.max(pool, -9);
    const half = (narrow + (wide - narrow) * near.along) / 2;
    return Math.max(pool, 1 - near.distance / half);
  }

  /** How far into a pond or the stream (x, z) lies: 1 at its middle, 0 at its edge, less outside. */
  override pond(x: number, z: number): number {
    return Math.max(super.pond(x, z), this.streamAt(x, z));
  }

  /** How much (x, z) is on a path: 1 down its middle, falling to 0 a little past its edge; and whether its stones are laid. */
  path(x: number, z: number): { share: number; stones: boolean } {
    let share = 0;
    let stones = false;
    for (const trail of this.trails) {
      const near = nearCourse(trail.course, x, z, trail.half + 0.3);
      if (!near) continue;
      const on = smooth(trail.half + 0.25, trail.half - 0.2, near.distance);
      if (on > share) {
        share = on;
        stones = trail.stones;
      }
    }
    return { share, stones };
  }

  /** How sandy the ground at (x, z) is: 1 on the beach's dry sand and its shelf, 0 on a rocky bank or the lawn. */
  sand(x: number, z: number): number {
    const bearing = Math.atan2(z, x);
    const beach = this.estate.coast.share(bearing, 'beach');
    if (beach <= 0) return 0;
    const { lawn } = this.estate.coast.bank(bearing);
    return beach * smooth(lawn + 0.2, lawn - 0.6, this.shore(x, z));
  }

  override height(x: number, z: number): number {
    const inside = this.shore(x, z);
    const { lawn, bed } = this.estate.coast.bank(Math.atan2(z, x));
    const slope = smooth(-bed, lawn, inside);
    let height = -1.5 + 1.5 * slope;
    // A rocky bank is broken ground: ledges and hollows, more of them the steeper it falls. A beach is smooth.
    if (slope > 0 && slope < 1 && bed < 2.5) height += ((noise2(x * 1.6 + 31, z * 1.6 + 7) - 0.5) * 0.2 + (noise2(x * 5 + 3, z * 5 + 11) - 0.5) * 0.07) * (1 - Math.abs(slope * 2 - 1));
    const pond = this.pond(x, z);
    if (pond > -0.3) height = Math.min(height, -0.95 * smooth(-0.3, 0.45, pond));
    return height;
  }
}

/**
 * What the lake needs to meet an estate's coast, sampled over the square `extent` metres to either side of its middle,
 * `size` by `size`: for each point, how far outside the waterline's line it lies (negative ashore, as the lake's own
 * shore model counts `out` from its rounded square), and the water's depth there (the lake's level less the ground's,
 * negative where the ground stands above it). Two numbers a point, row by row from -extent in z, each row from -extent
 * in x: a texture the lake's shader reads in place of its rounded square for the estate.
 */
export function seaField(site: EstateSite, size = 256): { data: Float32Array; size: number; extent: number } {
  const extent = Math.ceil(site.estate.coast.groundReach + 2);
  const data = new Float32Array(size * size * 2);
  for (let row = 0; row < size; row++) {
    const z = -extent + ((row + 0.5) / size) * extent * 2;
    for (let column = 0; column < size; column++) {
      const x = -extent + ((column + 0.5) / size) * extent * 2;
      const at = (row * size + column) * 2;
      data[at] = -site.shore(x, z);
      data[at + 1] = WATER_LEVEL - site.height(x, z);
    }
  }
  return { data, size, extent };
}
