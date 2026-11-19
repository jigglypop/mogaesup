import type { Terrain, TerrainCell } from '../api/types';

/** One metre of ground, in the island's own measure, wearing a terrain other than the island's fallback. */
export type { TerrainCell };

/** How many painted cells one island keeps: the whole of an estate's lawn (48 metres across). */
export const MOST_CELLS = 48 * 48;

const PAINTED = new Set<TerrainCell['terrain']>(['snow', 'desert', 'moss']);

/** A rectangle of whole cells, from its least corner to its greatest, both included. */
export type CellRect = { x0: number; z0: number; x1: number; z1: number };

/** The cell a point on the ground falls in. */
export function cellAt(x: number, z: number): { x: number; z: number } {
  return { x: Math.floor(x), z: Math.floor(z) };
}

/** The cells between the ones under two points, both included, however the two lie. */
export function rectOf(a: { x: number; z: number }, b: { x: number; z: number }): CellRect {
  const from = cellAt(a.x, a.z);
  const to = cellAt(b.x, b.z);
  return { x0: Math.min(from.x, to.x), z0: Math.min(from.z, to.z), x1: Math.max(from.x, to.x), z1: Math.max(from.z, to.z) };
}

/** `cells` after painting `terrain` on every cell of `rect`. `default` clears them; the newest cells are kept first. */
export function paintRect(cells: readonly TerrainCell[], rect: CellRect, terrain: Terrain): TerrainCell[] {
  const inside = (cell: { x: number; z: number }) => cell.x >= rect.x0 && cell.x <= rect.x1 && cell.z >= rect.z0 && cell.z <= rect.z1;
  const rest = cells.filter((cell) => !inside(cell));
  if (terrain === 'default' || !PAINTED.has(terrain)) return rest;
  const painted: TerrainCell[] = [];
  for (let z = rect.z0; z <= rect.z1; z++) for (let x = rect.x0; x <= rect.x1; x++) painted.push({ x, z, terrain });
  return [...rest, ...painted].slice(-MOST_CELLS);
}

/** `cells` after painting `terrain` on each of `targets` (whole cells). `default` clears them; the newest are kept first. */
export function paintAll(cells: readonly TerrainCell[], targets: readonly { x: number; z: number }[], terrain: Terrain): TerrainCell[] {
  const hit = new Set(targets.map((cell) => `${cell.x},${cell.z}`));
  const rest = cells.filter((cell) => !hit.has(`${cell.x},${cell.z}`));
  if (terrain === 'default' || !PAINTED.has(terrain)) return rest;
  const painted = [...hit].map((key) => {
    const [x, z] = key.split(',').map(Number) as [number, number];
    return { x, z, terrain };
  });
  return [...rest, ...painted].slice(-MOST_CELLS);
}

/** `cells` after painting `terrain` on the cell under (`x`, `z`). `default` clears that cell. */
export function paintCells(cells: readonly TerrainCell[], x: number, z: number, terrain: Terrain): TerrainCell[] {
  return paintRect(cells, rectOf({ x, z }, { x, z }), terrain);
}
