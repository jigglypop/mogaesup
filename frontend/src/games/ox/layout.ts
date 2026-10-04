import type { BuildingSerializedState } from 'gaesup-world/building';

import { modelBounds } from '../../minihome/edit/bounds';
import { footprintsOverlap, objectFootprint, type XZ } from '../../minihome/edit/layout';
import { CELL } from '../../minihome/village';
import type { Vec3 } from '../protocol';

/** How far a zone reaches from its spot on the ground, as the server judges it (server/src/games/ox.rs). */
export const ZONE_RADIUS = 4.5;
/** The server takes spots 12 to 30 m apart; a centimeter inside that, so no rounding tips a pair over. */
const MIN_APART = 12.01;
const MAX_APART = 29.99;
/** Best about this far apart: well clear of each other, and a short run across. */
const BEST_APART = 16;
/** Best about this far from the host: a few steps away. */
const BEST_AWAY = BEST_APART / 2;
/** How far a zone `away` from the host is from the best; nearer counts double, as everyone starts around the host. */
const amiss = (away: number) => (away < BEST_AWAY ? (BEST_AWAY - away) * 2 : away - BEST_AWAY);
// What a zone's ground is worth, in meters nearer the host: open spots inside it are room to stand; placed things
// reaching into it (by their footprint in m², the largest counting as this much) and cells of tall grass, which hides
// its marks, are in the way.
const OPEN_WORTH = 1.5;
const THING_MOST = 8;
const GRASS_COST = 4;

const ground = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);

function middle(spots: readonly Vec3[]): Vec3 {
  const sum = spots.reduce<Vec3>((total, spot) => [total[0] + spot[0], total[1] + spot[1], total[2] + spot[2]], [0, 0, 0]);
  return spots.length ? [sum[0] / spots.length, sum[1] / spots.length, sum[2] / spots.length] : sum;
}

/** A zone's ground as a polygon: a regular dodecagon around the circle. */
const circle = ([x, , z]: Vec3, radius: number): XZ[] =>
  Array.from({ length: 12 }, (_, index) => [x + radius * Math.cos((index * Math.PI) / 6), z + radius * Math.sin((index * Math.PI) / 6)]);

const area = (polygon: readonly XZ[]) =>
  Math.abs(polygon.reduce((sum, [x, z], index) => {
    const [nextX, nextZ] = polygon[(index + 1) % polygon.length]!;
    return sum + x * nextZ - nextX * z;
  }, 0)) / 2;

/** Whether `box` reaches into `zone`; a footprint with no extent (a model measured flat) reaches nowhere. */
function reaches(zone: readonly XZ[], box: readonly XZ[]): boolean {
  try {
    return footprintsOverlap(zone, box);
  } catch {
    return false;
  }
}

/** What stands in the way of a zone at a spot on `building`: placed things reaching into it, and tall grass. */
function clutter(building: BuildingSerializedState): (spot: Vec3) => number {
  const things = [
    ...building.objects.map((object) =>
      objectFootprint(object, object.type === 'model' && object.config?.modelUrl ? modelBounds(object.config.modelUrl) : undefined),
    ),
    ...building.blocks.map((block) => {
      const [x0, z0] = [block.position.x - CELL / 2, block.position.z - CELL / 2];
      const [x1, z1] = [x0 + CELL * (block.size?.x ?? 1), z0 + CELL * (block.size?.z ?? 1)];
      return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] as XZ[];
    }),
  ].map((box) => {
    // A circle around the footprint, to pass over far zones without testing them.
    const [x, z] = box.reduce(([sx, sz], [px, pz]) => [sx + px / box.length, sz + pz / box.length], [0, 0]);
    const reach = Math.max(...box.map(([px, pz]) => Math.hypot(px - x, pz - z)));
    return { box, at: [x, 0, z] as Vec3, reach, cost: Math.min(area(box), THING_MOST) };
  });
  // The centre of every cell whose tile grows tall grass.
  const grass: Vec3[] = building.tileGroups.flatMap((group) =>
    group.tiles
      .filter((tile) => tile.objectType === 'grass')
      .flatMap((tile) => {
        const size = Math.max(1, Math.round(tile.size ?? 1));
        return Array.from({ length: size * size }, (_, index): Vec3 => [
          tile.position.x + ((index % size) - (size - 1) / 2) * CELL,
          tile.position.y,
          tile.position.z + (Math.floor(index / size) - (size - 1) / 2) * CELL,
        ]);
      }),
  );
  return (spot) => {
    const zone = circle(spot, ZONE_RADIUS);
    const placed = things.reduce(
      (sum, thing) => sum + (ground(thing.at, spot) <= ZONE_RADIUS + thing.reach && reaches(zone, thing.box) ? thing.cost : 0),
      0,
    );
    return placed + grass.filter((cell) => ground(cell, spot) <= ZONE_RADIUS).length * GRASS_COST;
  };
}

/**
 * Where O and X go: two of the island's open `spots` 12–30 m apart, each a few steps from the host (`around`; the
 * middle of the spots while the host stands nowhere yet), on ground as open and clear as there is (`building`, when
 * given, says what stands where). O is the western one.
 */
export function oxLayout(spots: readonly Vec3[], around: Vec3 | null, building?: BuildingSerializedState): { o: Vec3; x: Vec3 } {
  const center = around ?? middle(spots);
  const cluttered = building ? clutter(building) : () => 0;
  // Each spot's ground as a zone: other open spots inside it are good, anything in the way is not.
  const worth = spots.map(
    (spot) => spots.filter((other) => other !== spot && ground(spot, other) <= ZONE_RADIUS).length * OPEN_WORTH - cluttered(spot),
  );
  let best: [Vec3, Vec3] | null = null;
  let lowest = Infinity;
  for (let i = 0; i < spots.length; i++) {
    for (let j = i + 1; j < spots.length; j++) {
      const [a, b] = [spots[i]!, spots[j]!];
      const apart = ground(a, b);
      if (apart < MIN_APART || apart > MAX_APART) continue;
      const away = Math.max(amiss(ground(center, a)), amiss(ground(center, b)));
      const cost = away + Math.abs(apart - BEST_APART) / 2 - worth[i]! - worth[j]!;
      if (cost < lowest) {
        lowest = cost;
        best = [a, b];
      }
    }
  }
  if (!best) throw new Error('O와 X를 놓을 자리가 없어요.');
  const [a, b] = best;
  return a[0] < b[0] || (a[0] === b[0] && a[2] < b[2]) ? { o: a, x: b } : { o: b, x: a };
}
