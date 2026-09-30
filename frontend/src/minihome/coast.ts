import { buildingCellToWorld, createTileFootprint, tilePositionToCell, type TileConfig } from 'gaesup-world/building';

import { CELL } from './village';

/** An invisible collider box: its center and half extents in meters. */
export type CoastBox = { position: [number, number, number]; halfExtents: [number, number, number] };

/** The shore walls reach from under the sea to past the highest jump. */
const WALL_BOTTOM = -2;
const WALL_TOP = 6;
/** The sea floor sits under the water (at -0.3 m) and spreads as far as the drawn sea. */
const SEABED_TOP = -1;
const SEABED_HALF = 240;

/** A floor under the whole sea, so nothing that slips past the shore falls forever. */
export const SEABED: CoastBox = { position: [0, SEABED_TOP - 0.5, 0], halfExtents: [SEABED_HALF, 0.5, SEABED_HALF] };

const key = (x: number, z: number) => `${x},${z}`;

function wall(z: number, x0: number, x1: number): CoastBox {
  const west = buildingCellToWorld({ x: x0, z, level: 0 });
  const east = buildingCellToWorld({ x: x1, z, level: 0 });
  return {
    position: [(west.x + east.x) / 2, (WALL_BOTTOM + WALL_TOP) / 2, west.z],
    halfExtents: [(east.x - west.x + CELL) / 2, (WALL_TOP - WALL_BOTTOM) / 2, CELL / 2],
  };
}

/**
 * Walls on every empty grid cell that touches the island (diagonals too), merged along each row: walkers reach the
 * water's edge and stop there. A hole left in the island is walled the same way.
 */
export function shoreWalls(tiles: Iterable<Pick<TileConfig, 'position' | 'size'>>): CoastBox[] {
  const land = new Set<string>();
  const cells: { x: number; z: number }[] = [];
  for (const tile of tiles) {
    for (const cell of createTileFootprint(tilePositionToCell(tile.position), tile.size ?? 1)) {
      if (land.has(key(cell.x, cell.z))) continue;
      land.add(key(cell.x, cell.z));
      cells.push(cell);
    }
  }
  const rows = new Map<number, Set<number>>();
  for (const { x, z } of cells) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (land.has(key(x + dx, z + dz))) continue;
        let row = rows.get(z + dz);
        if (!row) rows.set(z + dz, (row = new Set()));
        row.add(x + dx);
      }
    }
  }
  const walls: CoastBox[] = [];
  for (const [z, row] of rows) {
    const xs = [...row].sort((a, b) => a - b);
    let start = xs[0]!;
    let end = start;
    for (const x of xs.slice(1)) {
      if (x === end + 1) {
        end = x;
        continue;
      }
      walls.push(wall(z, start, end));
      start = end = x;
    }
    walls.push(wall(z, start, end));
  }
  return walls;
}
