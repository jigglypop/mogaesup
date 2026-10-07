import { describe, expect, it } from 'vitest';

import type { BufferGeometry } from 'three';

import { standFor } from '../arena';
import { band, fan, roundedOutline } from '../kart/shapes';
import type { Flat } from '../kart/track';

/** The up-component of every triangle's face normal, as three.js winds them. */
function ups(geometry: BufferGeometry): number[] {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex()!;
  const point = (at: number) => [position.getX(at), position.getY(at), position.getZ(at)] as const;
  const result: number[] = [];
  for (let at = 0; at < index.count; at += 3) {
    const [a, b, c] = [point(index.getX(at)), point(index.getX(at + 1)), point(index.getX(at + 2))];
    // (c - b) × (a - b), as three.js computes a face's normal.
    const [cb, ab] = [[c[0] - b[0], c[1] - b[1], c[2] - b[2]], [a[0] - b[0], a[1] - b[1], a[2] - b[2]]];
    result.push(cb[2]! * ab[0]! - cb[0]! * ab[2]!);
  }
  return result;
}

describe('카트 섬의 땅', () => {
  it('둥근 사각형 땅과 띠는 어느 방향으로 돌아도 모든 면이 위를 본다', () => {
    const outline = roundedOutline([-10, -6], [10, 6], 3, 4);
    const larger = roundedOutline([-14, -10], [14, 10], 7, 4);
    expect(outline).toHaveLength(larger.length);
    for (const [near, far] of [
      [outline, larger],
      [[...outline].reverse(), [...larger].reverse()],
    ] as [Flat[], Flat[]][]) {
      expect(ups(fan(near, 0)).every((up) => up > 0)).toBe(true);
      expect(ups(band(near, far, 0, -0.5)).every((up) => up > 0)).toBe(true);
    }
    // The outline stays within its rectangle and reaches each side.
    const xs = outline.map(([x]) => x);
    const zs = outline.map(([, z]) => z);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)].map((value) => Math.round(value * 1000) / 1000)).toEqual([-10, 10, -6, 6]);
  });

  it('구경하는 사람은 자리 둘레 1.5m 안에 사람마다 다른 곳에 선다', () => {
    const stand: [number, number, number] = [-56, 0, 109.5];
    const spots = ['a', 'bb', 'user-1', 'user-2', 'someone'].map((you) => standFor({ stand, you })!);
    for (const spot of spots) {
      expect(spot[1]).toBe(0);
      expect(Math.hypot(spot[0] - stand[0], spot[2] - stand[2])).toBeLessThanOrEqual(1.5);
    }
    expect(new Set(spots.map((spot) => spot.join())).size).toBe(spots.length);
    expect(standFor({ stand, you: 'a' })).toEqual(spots[0]);
    expect(standFor({ stand: null, you: 'a' })).toBeNull();
  });
});
