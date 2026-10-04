import type { BuildingSerializedState, TileConfig } from 'gaesup-world/building';

import { modelBounds } from '../minihome/edit/bounds';
import { footprintsOverlap, objectFootprint, type XZ } from '../minihome/edit/layout';
import type { LocalBox } from '../minihome/edit/objects';
import { CELL } from '../minihome/village';
import type { Vec3 } from './protocol';

/** The farthest the server takes a layout point from the island's centre, on each axis. */
const LIMIT = 200;
/** The most points a layout may carry. */
export const MAX_SPOTS = 200;
/** Fewer open floor cells than this, and the island's grid fills in. */
const ENOUGH = 12;
/** How far a spot keeps from anything placed, in meters. */
const CLEARANCE = 0.6;

export type SpotOptions = {
  /** Bounds of a placed model's GLB when known (the shared measurements by default); unknown ones get a size by kind. */
  bounds?: (url: string) => LocalBox | undefined;
  /** The most spots to return, spread evenly over all of them. */
  limit?: number;
  /** Below this many, points of a grid over the island's extent fill in. */
  minimum?: number;
};

/** Ground the player walks on: flat box tiles at ground level that are not water, a field or snow. */
const walkable = (tile: TileConfig) =>
  (tile.shape ?? 'box') === 'box' && tile.position.y === 0 && !['water', 'farm', 'snowfield'].includes(tile.objectType ?? 'none');

const square = (x: number, z: number, half: number): XZ[] => [[x - half, z - half], [x + half, z - half], [x + half, z + half], [x - half, z + half]];
const rounded = (value: number) => Math.round(value * 100) / 100;
/** Whether `box` reaches into `area`; a footprint with no extent (a model measured flat) covers nothing. */
function covers(area: readonly XZ[], box: readonly XZ[]): boolean {
  try {
    return footprintsOverlap(area, box);
  } catch {
    return false;
  }
}

/**
 * Open walkable spots on the island as `building` has it: the centre of every walkable floor cell that nothing placed
 * (an object's footprint, a block) covers, nearest the north-west first. An island with too few gets points of a grid
 * over its extent as well. Rounded to centimeters, within the server's bounds, and at most `limit` of them.
 */
export function openSpots(building: BuildingSerializedState, options: SpotOptions = {}): Vec3[] {
  const { bounds = modelBounds, limit = MAX_SPOTS, minimum = ENOUGH } = options;
  const obstacles: XZ[][] = [
    ...building.objects.map((object) =>
      objectFootprint(object, object.type === 'model' && object.config?.modelUrl ? bounds(object.config.modelUrl) : undefined),
    ),
    ...building.blocks.map((block) => {
      const [x0, z0] = [block.position.x - CELL / 2, block.position.z - CELL / 2];
      return [[x0, z0], [x0 + CELL * (block.size?.x ?? 1), z0], [x0 + CELL * (block.size?.x ?? 1), z0 + CELL * (block.size?.z ?? 1)], [x0, z0 + CELL * (block.size?.z ?? 1)]] as XZ[];
    }),
  ];
  const free = ([x, z]: XZ) => {
    const around = square(x, z, CLEARANCE);
    return Math.abs(x) <= LIMIT && Math.abs(z) <= LIMIT && !obstacles.some((box) => covers(around, box));
  };
  const seen = new Set<string>();
  const spots: Vec3[] = [];
  const add = (x: number, y: number, z: number) => {
    const spot: Vec3 = [rounded(x), rounded(y), rounded(z)];
    const key = `${spot[0]}:${spot[2]}`;
    if (seen.has(key) || !free([spot[0], spot[2]])) return;
    seen.add(key);
    spots.push(spot);
  };
  const tiles = building.tileGroups.flatMap((group) => group.tiles);
  for (const tile of tiles.filter(walkable)) {
    // A tile `size` cells across has that many cell centres along each side.
    const size = Math.max(1, Math.round(tile.size ?? 1));
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        add(tile.position.x + (i - (size - 1) / 2) * CELL, tile.position.y, tile.position.z + (j - (size - 1) / 2) * CELL);
      }
    }
  }
  if (spots.length < minimum) {
    const xs = tiles.map((tile) => tile.position.x);
    const zs = tiles.map((tile) => tile.position.z);
    // Without tiles, the village's own extent.
    const [minX, maxX] = xs.length ? [Math.min(...xs), Math.max(...xs)] : [-28, 24];
    const [minZ, maxZ] = zs.length ? [Math.min(...zs), Math.max(...zs)] : [-28, 24];
    for (let z = minZ + CELL / 2; z < maxZ; z += CELL) for (let x = minX + CELL / 2; x < maxX; x += CELL) add(x, 0, z);
  }
  spots.sort((a, b) => a[2] - b[2] || a[0] - b[0]);
  if (spots.length <= limit) return spots;
  return Array.from({ length: limit }, (_, index) => spots[Math.floor((index * spots.length) / limit)]!);
}
