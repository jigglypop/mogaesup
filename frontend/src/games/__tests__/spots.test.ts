import { describe, expect, it } from 'vitest';

import type { BuildingSerializedState, PlacedObject } from 'gaesup-world/building';

import { footprintsOverlap, objectFootprint, type XZ } from '../../minihome/edit/layout';
import { at, createVillage } from '../../minihome/village';
import { openSpots } from '../spots';

/** No measured models: placed models count by their kind's size, as before the island's GLBs are measured. */
const unmeasured = { bounds: () => undefined };
const around = ([x, , z]: [number, number, number], half: number): XZ[] => [[x - half, z - half], [x + half, z - half], [x + half, z + half], [x - half, z + half]];

describe('게임 배치에 쓸 섬의 빈 자리', () => {
  it('모개숲의 걸을 수 있는 바닥 칸 가운데 중 무엇도 놓이지 않은 곳만 고른다', () => {
    const village = createVillage();
    const spots = openSpots(village, unmeasured);
    expect(spots.length).toBeGreaterThanOrEqual(12);
    expect(spots.length).toBeLessThanOrEqual(200);
    const tiles = new Map(village.tileGroups.flatMap((group) => group.tiles).map((tile) => [`${tile.position.x}:${tile.position.z}`, tile]));
    for (const spot of spots) {
      const tile = tiles.get(`${spot[0]}:${spot[2]}`);
      expect(tile, `${spot}`).toBeDefined();
      expect(tile!.position.y).toBe(0);
      expect(['water', 'farm']).not.toContain(tile!.objectType);
      expect(spot[1]).toBe(0);
      for (const object of village.objects) expect(footprintsOverlap(around(spot, 0.6), objectFootprint(object))).toBe(false);
    }
    // The pond, the field and the forest cliff stay out; the crossroads and the beach are in.
    expect(spots).not.toContainEqual([at(1), 0, at(7)]);
    expect(spots).not.toContainEqual([at(10), 0, at(7)]);
    expect(spots).not.toContainEqual([at(5), 0, at(0)]);
    expect(spots).toContainEqual([at(8), 0, at(5)]);
    expect(spots).toContainEqual([at(3), 0, at(13)]);
    // North-west first, each once.
    const keys = spots.map((spot) => `${spot[0]}:${spot[2]}`);
    expect(new Set(keys).size).toBe(spots.length);
    expect(spots).toEqual([...spots].sort((a, b) => a[2] - b[2] || a[0] - b[0]));
  });

  it('놓인 물건이 덮은 칸은 빠진다', () => {
    const village = createVillage();
    const before = openSpots(village, unmeasured);
    const crate: PlacedObject = { id: 'crate', type: 'model', position: { x: at(8) + 0.3, y: 0, z: at(5) - 0.2 }, config: { modelUrl: '/gltf/crate.glb' } };
    const after = openSpots({ ...village, objects: [...village.objects, crate] }, unmeasured);
    expect(after).toHaveLength(before.length - 1);
    expect(after).not.toContainEqual([at(8), 0, at(5)]);
    // Measured bounds count when known: a wide model covers its neighbours too.
    const wide = openSpots({ ...village, objects: [...village.objects, crate] }, { bounds: () => ({ min: [-5, 0, -0.5], max: [5, 1, 0.5] }) });
    expect(wide).not.toContainEqual([at(9), 0, at(5)]);
    expect(wide).not.toContainEqual([at(7), 0, at(5)]);
  });

  it('바닥이 모자라면 섬 범위의 격자로 채우고, 큰 타일은 칸마다, 너무 많으면 고르게 줄인다', () => {
    const bare: BuildingSerializedState = { ...createVillage(), tileGroups: [], objects: [], blocks: [] };
    const grid = openSpots(bare);
    expect(grid.length).toBeGreaterThanOrEqual(12);
    expect(grid.every(([x, , z]) => Math.abs(x) <= 28 && Math.abs(z) <= 28)).toBe(true);

    const big: BuildingSerializedState = {
      ...bare,
      tileGroups: [{ id: 'g', name: 'g', floorMeshId: 'lawn', tiles: [{ id: 't', tileGroupId: 'g', size: 2, position: { x: 10, y: 0, z: 10 } }] }],
    };
    expect(openSpots(big, { minimum: 0 })).toEqual([[8, 0, 8], [12, 0, 8], [8, 0, 12], [12, 0, 12]]);

    const all = openSpots(createVillage(), unmeasured);
    const few = openSpots(createVillage(), { ...unmeasured, limit: 10 });
    expect(few).toHaveLength(10);
    expect(few[0]).toEqual(all[0]);
    expect(few.every((spot) => all.some((other) => other.join() === spot.join()))).toBe(true);
    expect(few.at(-1)![2]).toBeGreaterThan(all[Math.floor(all.length / 2)]![2]);
  });

  it('서버가 받는 범위 밖과 블록 위는 고르지 않는다', () => {
    const far: BuildingSerializedState = {
      ...createVillage(),
      objects: [],
      blocks: [{ id: 'b', position: { x: at(8), y: 0, z: at(5) } }],
      tileGroups: [{ id: 'g', name: 'g', floorMeshId: 'lawn', tiles: [
        { id: 'a', tileGroupId: 'g', position: { x: 196, y: 0, z: 0 } },
        { id: 'b', tileGroupId: 'g', position: { x: 204, y: 0, z: 0 } },
        { id: 'c', tileGroupId: 'g', position: { x: at(8), y: 0, z: at(5) } },
        { id: 'd', tileGroupId: 'g', position: { x: 0.123456, y: 0, z: -0.987654 } },
      ] }],
    };
    expect(openSpots(far, { minimum: 0 })).toEqual([[0.12, 0, -0.99], [196, 0, 0]]);
  });
});
