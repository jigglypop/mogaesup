import { describe, expect, it } from 'vitest';

import type { PlacedObject, TileGroupConfig } from 'gaesup-world/building';

import {
  degreesOf,
  freeSpotNear,
  groundAxes,
  groundHeightAt,
  isSpotFree,
  objectLabel,
  pickBoxOf,
  pickObject,
  positionAt,
  resized,
  ringOffsets,
  sizeOf,
  snapToGrid,
  turned,
  type Ray,
} from '../edit/objects';

const model = (id: string, x: number, z: number, extra: Partial<PlacedObject> = {}): PlacedObject => ({
  id,
  type: 'model',
  position: { x, y: 0, z },
  config: { modelId: 'chair-basic', modelLabel: '의자', modelScale: 0.65 },
  ...extra,
});
const tiles: TileGroupConfig[] = [
  {
    id: 'ground',
    name: 'ground',
    floorMeshId: 'lawn',
    tiles: [
      { id: 'low', tileGroupId: 'ground', position: { x: 0, y: 0, z: 0 } },
      { id: 'raised', tileGroupId: 'ground', position: { x: 4, y: 1, z: 0 } },
    ],
  },
];
/** A ray from above and in front, down onto (x, 0, z). */
const rayAt = (x: number, z: number, y = 0): Ray => {
  const origin: [number, number, number] = [x, y + 10, z + 10];
  const length = Math.hypot(10, 10);
  return { origin, direction: [0, -10 / length, -10 / length] };
};

describe('placed object helpers', () => {
  it('한 칸에 하나만: 다른 물건이 선 자리는 막히고, 자기 자리는 비어 있다', () => {
    const objects = [model('a', 0, 0), model('b', 1, 0)];
    expect(isSpotFree(objects, 0, 0)).toBe(false);
    expect(isSpotFree(objects, 0, 0, 'a')).toBe(true);
    expect(isSpotFree(objects, 0.6, 0, 'a')).toBe(false);
    expect(isSpotFree(objects, 2, 0)).toBe(true);
  });

  it('복제할 자리는 가까운 빈칸부터, 오른쪽을 먼저 찾는다', () => {
    expect(ringOffsets(1).slice(0, 4)).toEqual([
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ]);
    const objects = [model('a', 0, 0), model('b', 1, 0)];
    expect(freeSpotNear(objects, 0, 0)).toEqual({ x: 0, z: 1 });
    expect(freeSpotNear(objects, 0, 0, 2)).toEqual({ x: 2, z: 0 });
  });

  it('옮긴 물건은 그 자리 바닥 높이에 서고, 바닥 위로 띄운 높이는 그대로다', () => {
    expect(groundHeightAt(tiles, 4, 1)).toBe(1);
    expect(groundHeightAt(tiles, 0, 1)).toBe(0);
    expect(positionAt(model('a', 0, 0), 4, 1, tiles)).toEqual({ x: 4, y: 1, z: 1 });
    const sign = model('sign', 0, 0, { type: 'billboard', position: { x: 0, y: 0.5, z: 0 } });
    expect(positionAt(sign, 4, -1, tiles)).toEqual({ x: 4, y: 1.5, z: -1 });
    expect(snapToGrid(-17.4)).toBe(-17);
    expect(positionAt(model('a', -18.4, 0), -18.4 + 1, 0, [])).toEqual({ x: -17.4, y: 0, z: 0 });
  });

  it('돌리기는 걸음 단위에 맞춰 붙는다', () => {
    expect(degreesOf(turned(0, 90))).toBe(90);
    expect(degreesOf(turned(0.4, 90))).toBe(90);
    expect(degreesOf(turned(Math.PI * 1.5, 90))).toBe(0);
    expect(degreesOf(turned(0, -90))).toBe(270);
    expect(degreesOf(turned(Math.PI / 2, 45))).toBe(135);
    expect(degreesOf(undefined)).toBe(0);
  });

  it('누른 곳의 물건을 고르고, 큰 상자 안의 작은 물건을 먼저 고른다', () => {
    const tree: PlacedObject = { id: 'tree', type: 'tree', position: { x: 0, y: 0, z: 0 }, config: { size: 4 } };
    const chair = model('chair', 0.5, 0.5);
    expect(pickObject(rayAt(0.5, 0.5), [tree, chair])?.id).toBe('chair');
    expect(pickObject(rayAt(-1.2, -1.2, 3), [tree, chair])?.id).toBe('tree');
    expect(pickObject(rayAt(20, 20), [tree, chair])).toBeNull();
  });

  it('모델은 잰 크기와 방향으로 고른다', () => {
    // A long bench, 4 m along its own X, turned a quarter: it now runs along Z.
    const bounds = () => ({ min: [-2, 0, -0.25] as const, max: [2, 0.8, 0.25] as const });
    const bench = model('bench', 0, 0, { rotation: Math.PI / 2, config: { modelUrl: 'gltf/bench.glb', modelScale: 1 } });
    expect(pickObject(rayAt(0, 1.8), [bench], bounds)?.id).toBe('bench');
    expect(pickObject(rayAt(1.8, 0), [bench], bounds)).toBeNull();
    const flat = pickBoxOf({ ...bench, rotation: 0 }, () => ({ min: [-0.1, 0, -0.1], max: [0.1, 0.01, 0.1] }));
    expect(flat.max[1] - flat.min[1]).toBeGreaterThanOrEqual(0.3);
    expect(flat.max[0] - flat.min[0]).toBeGreaterThanOrEqual(0.6);
  });

  it('화살표는 화면 방향에 가까운 격자 축으로 옮긴다', () => {
    expect(groundAxes(0, -1)).toEqual({ forward: [0, -1], right: [1, 0] });
    expect(groundAxes(0.9, 0.3)).toEqual({ forward: [1, 0], right: [0, 1] });
    expect(groundAxes(-0.2, 0.8)).toEqual({ forward: [0, 1], right: [-1, 0] });
  });

  it('크기는 카탈로그 크기의 배수로 바꾸고, 범위를 넘지 않는다', () => {
    const chair = model('chair', 0, 0);
    expect(sizeOf(chair)).toBe(1);
    expect(resized(chair, 1.5)?.modelScale).toBeCloseTo(0.975);
    expect(resized(chair, 9)?.modelScale).toBeCloseTo(1.3);
    const tree: PlacedObject = { id: 't', type: 'sakura', position: { x: 0, y: 0, z: 0 }, config: { size: 3.4 } };
    expect(sizeOf(tree)).toBe(0.85);
    expect(resized(tree, 0.1)?.size).toBe(2);
    expect(sizeOf({ id: 'f', type: 'fire', position: { x: 0, y: 0, z: 0 } })).toBeNull();
  });

  it('이름은 카탈로그·스튜디오·나무 종류에서 온다', () => {
    expect(objectLabel(model('a', 0, 0))).toBe('의자');
    const studio = model('s', 0, 0, { config: { modelId: 'desk-9', modelLabel: 'desk-9' } });
    expect(objectLabel(studio)).toBe('물건');
    expect(objectLabel(studio, new Map([['desk-9', '원목 책상']]))).toBe('원목 책상');
    expect(objectLabel({ id: 't', type: 'tree', position: { x: 0, y: 0, z: 0 }, config: { treeKind: 'maple' } })).toBe('단풍나무');
  });
});
