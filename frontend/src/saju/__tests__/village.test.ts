import { describe, expect, it } from 'vitest';

import { profileOf } from '../profile';
import { FLAG_ISLAND } from '../scene/flagIsland';
import { ISLANDS, shoreAt, type IslandShape } from '../scene/terrain';
import { bridgeSpan, CORNER_REACH, FLAG_NEIGHBOURS, FLAG_SPOT, flagRaised, PLOT_REACH, plotsOf } from '../village';
import { PEOPLE } from './people';

/** The page's own island in the middle and eight neighbours' about it: every plot a full village takes. */
const village = (): { x: number; z: number; shape: IslandShape }[] => [
  { x: 0, z: 0, shape: ISLANDS.home },
  ...plotsOf(Array.from({ length: 8 }, (_, index) => ({ id: `n${index}`, element: 'earth' as const }))).map(({ x, z }) => ({ x, z, shape: ISLANDS.neighbour })),
];

/** The water between two islands along the line joining their middles, waterline to waterline, before the lines wander. */
function water(a: { x: number; z: number; shape: IslandShape }, b: { x: number; z: number; shape: IslandShape }): number {
  const bearing = Math.atan2(b.z - a.z, b.x - a.x);
  return Math.hypot(b.x - a.x, b.z - a.z) - shoreAt(a.shape, bearing) - shoreAt(b.shape, bearing + Math.PI);
}

describe('마을 자리', () => {
  const R = PLOT_REACH;

  it('이웃은 제 오행의 방위에 자리를 잡고, 토는 남은 자리에 든다', () => {
    const neighbours = PEOPLE.map((resident) => ({ id: resident.id, element: profileOf(resident.birth).balance.dominant }));
    expect(plotsOf(neighbours)).toEqual([
      { id: 'sol', x: R, z: 0 },
      { id: 'noeul', x: 0, z: R },
      { id: 'bori', x: -R, z: 0 },
      { id: 'garam', x: 0, z: -R },
    ]);
  });

  it('같은 오행이 겹치면 다음 빈자리로 간다', () => {
    const plots = plotsOf([
      { id: 'a', element: 'fire' },
      { id: 'b', element: 'fire' },
      { id: 'c', element: 'metal' },
    ]);
    expect(plots).toEqual([
      { id: 'b', x: R, z: 0 },
      { id: 'a', x: 0, z: R },
      { id: 'c', x: -R, z: 0 },
    ]);
    expect(new Set(plots.map((plot) => `${plot.x},${plot.z}`)).size).toBe(3);
  });

  it('자리보다 이웃이 많으면 자리만큼만 놓는다', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ id: `n${index}`, element: 'earth' as const }));
    const plots = plotsOf(many);
    expect(plots).toHaveLength(8);
    expect(new Set(plots.map((plot) => `${plot.x},${plot.z}`)).size).toBe(8);
    expect(plots.every((plot) => plot.x !== 0 || plot.z !== 0)).toBe(true);
  });

  it('이웃이 열 명이 되면 깃발이 오른다', () => {
    expect(FLAG_NEIGHBOURS).toBe(10);
    expect([0, 9, 10, 11].map(flagRaised)).toEqual([false, false, true, true]);
  });
});

describe('섬 사이의 물', () => {
  const islands = village();
  const [middle, ...around] = islands;
  const pairs = around.flatMap((a, index) => around.slice(index + 1).map((b) => [a, b] as const));

  it('넓은 가운데 섬 둘레에 이웃 섬 여덟이 고리처럼 둘러서고, 어느 이웃과도 다리 하나 길이의 물을 둔다', () => {
    expect(around).toHaveLength(8);
    for (const plot of around) expect(water(middle!, plot)).toBeCloseTo(3, 6);
    // 변의 이웃은 가운데에서 PLOT_REACH, 모서리의 이웃은 동서로도 남북으로도 CORNER_REACH만큼 떨어진다.
    expect(around.filter(({ x, z }) => x === 0 || z === 0).every(({ x, z }) => Math.hypot(x, z) === PLOT_REACH)).toBe(true);
    expect(around.filter(({ x, z }) => x !== 0 && z !== 0).every(({ x, z }) => Math.abs(x) === CORNER_REACH && Math.abs(z) === CORNER_REACH)).toBe(true);
    expect(CORNER_REACH).toBeLessThan(PLOT_REACH);
  });

  it('둘레의 섬끼리는 서로 닿지 않는다', () => {
    expect(pairs).toHaveLength(28);
    // 물가는 반 미터 안팎으로 구불거리므로 가장 가까운 곳에도 물이 1.5미터 넘게 남는다.
    for (const [a, b] of pairs) expect(water(a, b)).toBeGreaterThan(2.5);
  });

  it('한 섬의 둑은 옆 섬의 물가에 닿기 전에 호수 바닥에 이른다', () => {
    for (const [a, b] of [...around.map((plot) => [middle!, plot] as const), ...pairs]) {
      const bearing = Math.atan2(b.z - a.z, b.x - a.x);
      const apart = Math.hypot(b.x - a.x, b.z - a.z);
      for (const [one, other, toward] of [[a, b, bearing], [b, a, bearing + Math.PI]] as const) {
        const bank = shoreAt(one.shape, toward) + (one.shape.reach - one.shape.half);
        expect(apart - bank - shoreAt(other.shape, toward + Math.PI)).toBeGreaterThan(0.5);
      }
    }
  });

  it('다리는 두 물가에 한 발씩 걸쳐 물 한가운데에 놓인다', () => {
    for (const plot of around) {
      const span = bridgeSpan(middle!, plot);
      const bearing = Math.atan2(plot.z, plot.x);
      const gap = water(middle!, plot);
      expect(span.length).toBeCloseTo(gap + 1.5, 6);
      expect(span.length).toBeGreaterThan(4);
      expect(span.length).toBeLessThan(9);
      // 다리의 가운데는 두 물가의 가운데이고, 두 섬의 가운데를 잇는 선 위에 있다.
      const out = Math.hypot(span.middle[0], span.middle[1]);
      expect(out).toBeCloseTo(shoreAt(ISLANDS.home, bearing) + gap / 2, 6);
      expect(Math.abs(span.middle[0] * Math.sin(bearing) - span.middle[1] * Math.cos(bearing))).toBeLessThan(1e-9);
    }
  });

  it('깃발 섬은 동쪽 섬에서 섬과 섬 사이만큼 넘게 떨어져 있고, 어느 섬에도 닿지 않는다', () => {
    const east = islands[1]!;
    expect(east).toEqual({ x: PLOT_REACH, z: 0, shape: ISLANDS.neighbour });
    const flag = { x: FLAG_SPOT.x, z: FLAG_SPOT.z, shape: FLAG_ISLAND };
    expect(water(east, flag)).toBeGreaterThan(water(middle!, east));
    // 동쪽 섬의 둑도 깃발 섬의 물가에 닿지 않는다.
    expect(FLAG_SPOT.x - FLAG_ISLAND.half - (east.x + ISLANDS.neighbour.reach)).toBeGreaterThan(1);
    for (const island of islands) expect(water(island, flag)).toBeGreaterThan(3);
  });
});
