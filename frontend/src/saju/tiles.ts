import type { Terrain } from '../api/types';

/** One metre of ground, in the island's own measure, wearing a terrain other than the island's fallback. */
export type TerrainCell = { x: number; z: number; terrain: Exclude<Terrain, 'default'> };

/** How many painted cells one island keeps. */
export const MOST_CELLS = 256;

const PAINTED = new Set<TerrainCell['terrain']>(['snow', 'desert', 'moss']);

/** The cell a point on the ground falls in. */
export function cellAt(x: number, z: number): { x: number; z: number } {
  return { x: Math.floor(x), z: Math.floor(z) };
}

/** `cells` after painting `terrain` on the cell under (`x`, `z`). `default` clears that cell. */
export function paintCells(cells: readonly TerrainCell[], x: number, z: number, terrain: Terrain): TerrainCell[] {
  const at = cellAt(x, z);
  const rest = cells.filter((cell) => cell.x !== at.x || cell.z !== at.z);
  if (terrain === 'default' || !PAINTED.has(terrain)) return rest;
  return [...rest, { x: at.x, z: at.z, terrain }].slice(-MOST_CELLS);
}
