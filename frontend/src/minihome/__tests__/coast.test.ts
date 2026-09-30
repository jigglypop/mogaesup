import { describe, expect, it } from 'vitest';

import { shoreWalls } from '../coast';
import { CELL } from '../village';

const tile = (x: number, z: number, size = 1) => ({ position: { x: x * CELL, y: 0, z: z * CELL }, size });

/** The grid cells the walls cover, as "x,z". */
function covered(walls: ReturnType<typeof shoreWalls>): Set<string> {
  const cells = new Set<string>();
  for (const { position, halfExtents } of walls) {
    const z = Math.round(position[2] / CELL);
    const x0 = Math.round((position[0] - halfExtents[0] + CELL / 2) / CELL);
    const x1 = Math.round((position[0] + halfExtents[0] - CELL / 2) / CELL);
    for (let x = x0; x <= x1; x++) cells.add(`${x},${z}`);
  }
  return cells;
}

describe('shoreWalls', () => {
  it('rings a single tile with the eight cells around it, merged per row', () => {
    const walls = shoreWalls([tile(0, 0)]);
    expect(walls).toHaveLength(4);
    expect(covered(walls)).toEqual(new Set(['-1,-1', '0,-1', '1,-1', '-1,0', '1,0', '-1,1', '0,1', '1,1']));
  });

  it('walls a hole left inside the island', () => {
    const tiles = [];
    for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) if (x !== 1 || z !== 1) tiles.push(tile(x, z));
    const cells = covered(shoreWalls(tiles));
    expect(cells.has('1,1')).toBe(true);
    expect(cells.has('0,0')).toBe(false);
  });

  it('counts every cell a larger tile covers as land', () => {
    const cells = covered(shoreWalls([tile(0, 0, 3)]));
    expect(cells.has('1,1')).toBe(false);
    expect(cells.has('2,2')).toBe(true);
    expect(cells.size).toBe(16);
  });

  it('reaches from under the sea past a jump', () => {
    const [wall] = shoreWalls([tile(0, 0)]);
    expect(wall!.position[1] - wall!.halfExtents[1]).toBeLessThan(-0.3);
    expect(wall!.position[1] + wall!.halfExtents[1]).toBeGreaterThan(4);
  });

  it('has nothing to wall without land', () => {
    expect(shoreWalls([])).toEqual([]);
  });
});
