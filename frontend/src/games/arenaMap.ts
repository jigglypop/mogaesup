import type { Vec3 } from './protocol';

/**
 * The plain geometry of arenas (see arena.tsx): where they float, grid maps, their floor slabs and walls. Kept apart from
 * the components so a game's map module can use it without importing the game room.
 */

/** How high over the island arenas float, in meters (layout points stay within the server's 200). */
export const ARENA_Y = 80;

/** A box in the world: its centre and its full size along x, y and z. */
export type Box = { center: Vec3; size: Vec3 };

/** A map drawn as rows of characters, one cell `cell` meters wide each, the grid centred on `origin`. */
export type GridMap = { rows: readonly string[]; cell: number; origin: Vec3 };

/** The world point at the middle of cell (`col`, `row`); fractions land between cells. */
export function cellPoint({ rows, cell, origin }: GridMap, col: number, row: number): Vec3 {
  const width = Math.max(...rows.map((line) => line.length));
  return [origin[0] + (col - (width - 1) / 2) * cell, origin[1], origin[2] + (row - (rows.length - 1) / 2) * cell];
}

/** Every cell `walkable` takes, with its character. */
export function cells(map: GridMap, walkable: (mark: string) => boolean): { col: number; row: number; mark: string }[] {
  return map.rows.flatMap((line, row) => [...line].flatMap((mark, col) => (walkable(mark) ? [{ col, row, mark }] : [])));
}

/** The floor under the walkable cells: one slab per run of them along a row, `thickness` deep, its top at the origin. */
export function floorBoxes(map: GridMap, walkable: (mark: string) => boolean, thickness = 0.4): Box[] {
  const boxes: Box[] = [];
  map.rows.forEach((line, row) => {
    let start = -1;
    for (let col = 0; col <= line.length; col++) {
      const open = col < line.length && walkable(line[col]!);
      if (open && start < 0) start = col;
      if (!open && start >= 0) {
        const [left, right] = [cellPoint(map, start, row), cellPoint(map, col - 1, row)];
        boxes.push({
          center: [(left[0] + right[0]) / 2, map.origin[1] - thickness / 2, left[2]],
          size: [(col - start) * map.cell, thickness, map.cell],
        });
        start = -1;
      }
    }
  });
  return boxes;
}

/** Walls along every edge between a walkable cell and one that is not (or the map's edge), runs merged into one. */
export function wallBoxes(map: GridMap, walkable: (mark: string) => boolean, height = 2.6, thickness = 0.3): Box[] {
  const open = (col: number, row: number) => walkable(map.rows[row]?.[col] ?? ' ');
  const width = Math.max(...map.rows.map((line) => line.length));
  const boxes: Box[] = [];
  const y = map.origin[1] + height / 2;
  // Edges along x: above row `row` (between row - 1 and row).
  for (let row = 0; row <= map.rows.length; row++) {
    let start = -1;
    for (let col = 0; col <= width; col++) {
      const edge = col < width && open(col, row - 1) !== open(col, row);
      if (edge && start < 0) start = col;
      if (!edge && start >= 0) {
        const [left, right] = [cellPoint(map, start, row - 0.5), cellPoint(map, col - 1, row - 0.5)];
        boxes.push({ center: [(left[0] + right[0]) / 2, y, left[2]], size: [(col - start) * map.cell + thickness, height, thickness] });
        start = -1;
      }
    }
  }
  // Edges along z: left of column `col`.
  for (let col = 0; col <= width; col++) {
    let start = -1;
    for (let row = 0; row <= map.rows.length; row++) {
      const edge = row < map.rows.length && open(col - 1, row) !== open(col, row);
      if (edge && start < 0) start = row;
      if (!edge && start >= 0) {
        const [top, bottom] = [cellPoint(map, col - 0.5, start), cellPoint(map, col - 0.5, row - 1)];
        boxes.push({ center: [top[0], y, (top[2] + bottom[2]) / 2], size: [thickness, height, (row - start) * map.cell + thickness] });
        start = -1;
      }
    }
  }
  return boxes;
}
