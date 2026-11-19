import { describe, expect, it } from 'vitest';

import { cellAt, paintCells } from '../tiles';

describe('칸 타일', () => {
  it('점을 그 칸으로 내리고, 같은 칸은 덮으며, 잔디는 칸을 지운다', () => {
    expect(cellAt(1.2, -0.1)).toEqual({ x: 1, z: -1 });
    const snow = paintCells([], 1.2, -0.1, 'snow');
    expect(snow).toEqual([{ x: 1, z: -1, terrain: 'snow' }]);
    expect(paintCells(snow, 1.9, -0.2, 'moss')).toEqual([{ x: 1, z: -1, terrain: 'moss' }]);
    expect(paintCells(snow, 1.2, -0.4, 'default')).toEqual([]);
  });
});
