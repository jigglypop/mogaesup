import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBuildingStore, type BuildingSerializedState, type PlacedObject } from 'gaesup-world/building';

import { createEditHistory } from '../edit/history';

const chair = (id: string, x: number, z: number): PlacedObject => ({
  id,
  type: 'model',
  position: { x, y: 0, z },
  config: { modelId: 'chair-basic', modelUrl: 'gltf/props/chair.glb', modelScale: 0.65 },
});

const island = (objects: PlacedObject[]): Partial<BuildingSerializedState> => ({
  meshes: [{ id: 'lawn', color: '#8ccd65' }],
  tileGroups: [{ id: 'ground', name: 'ground', floorMeshId: 'lawn', tiles: [{ id: 't1', tileGroupId: 'ground', position: { x: 0, y: 0, z: 0 } }] }],
  wallGroups: [],
  objects,
});

describe('edit history', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('불러온 섬을 기준으로 삼아, 되돌려도 처음 마을로 돌아가지 않는다', () => {
    const store = createBuildingStore();
    store.getState().hydrate(island([chair('village', 0, 0)]));
    const history = createEditHistory(store);
    // The saved island arrives later; the history only starts once it has.
    store.getState().hydrate(island([chair('saved', 3, 3)]));
    history.start();
    expect(history.canUndo()).toBe(false);
    expect(history.undo()).toBe(false);
    expect(store.getState().objects.map((object) => object.id)).toEqual(['saved']);

    store.getState().addObject(chair('new', 5, 5));
    vi.advanceTimersByTime(300);
    expect(history.canUndo()).toBe(true);
    expect(history.undo()).toBe(true);
    expect(store.getState().objects.map((object) => object.id)).toEqual(['saved']);
    expect(history.canUndo()).toBe(false);
  });

  it('바닥이나 벽을 고르기만 하면 단계가 생기지 않고, 되돌려도 고른 바닥은 남는다', () => {
    const store = createBuildingStore();
    store.getState().hydrate(island([]));
    const history = createEditHistory(store);
    history.start();

    store.getState().applyTilePreset('oak-planks');
    store.getState().applyWallPreset('brick-house');
    vi.advanceTimersByTime(300);
    expect(history.canUndo()).toBe(false);

    const group = store.getState().selectedTileGroupId!;
    store.getState().addTile(group, { id: 'plank', tileGroupId: group, position: { x: 8, y: 0, z: 0 } });
    vi.advanceTimersByTime(300);
    expect(history.undo()).toBe(true);
    const state = store.getState();
    expect(state.tileGroups.get(group)?.tiles).toEqual([]);
    expect(state.selectedTileGroupId).toBe(group);
    expect(state.meshes.has('tile-oak-planks')).toBe(true);
    expect(history.redo()).toBe(true);
    expect(store.getState().tileGroups.get(group)?.tiles.map((tile) => tile.id)).toEqual(['plank']);
  });

  it('보이는 것이 같은 변경은 단계가 되지 않는다', () => {
    const store = createBuildingStore();
    store.getState().hydrate(island([chair('a', 1, 1)]));
    const history = createEditHistory(store);
    history.start();
    store.getState().updateObject('a', { position: { x: 1, y: 0, z: 1 } });
    vi.advanceTimersByTime(300);
    expect(history.canUndo()).toBe(false);
  });

  it('끌기 한 번은 한 단계이고, 멈춤 없이 이어진 변경도 한 단계다', () => {
    const store = createBuildingStore();
    store.getState().hydrate(island([chair('a', 0, 0)]));
    const history = createEditHistory(store);
    history.start();

    const release = history.hold();
    for (let x = 1; x <= 5; x++) {
      store.getState().updateObject('a', { position: { x, y: 0, z: 0 } });
      vi.advanceTimersByTime(400);
    }
    expect(history.canUndo()).toBe(false);
    release();
    expect(history.canUndo()).toBe(true);

    store.getState().updateObject('a', { rotation: Math.PI / 2 });
    store.getState().updateObject('a', { rotation: Math.PI });
    vi.advanceTimersByTime(300);
    history.undo();
    expect(store.getState().objects[0]?.rotation).toBeUndefined();
    expect(store.getState().objects[0]?.position.x).toBe(5);
    history.undo();
    expect(store.getState().objects[0]?.position.x).toBe(0);
  });

  it('되돌리기 직전의 변경도 바로 되돌리고, 새 변경은 다시 하기를 지운다', () => {
    const store = createBuildingStore();
    store.getState().hydrate(island([]));
    const history = createEditHistory(store);
    history.start();
    store.getState().addObject(chair('a', 0, 0));
    // No pause yet: undo records the pending change first.
    expect(history.undo()).toBe(true);
    expect(store.getState().objects).toEqual([]);
    expect(history.canRedo()).toBe(true);
    store.getState().addObject(chair('b', 2, 2));
    vi.advanceTimersByTime(300);
    expect(history.canRedo()).toBe(false);
  });

  it('단계 수는 한도까지만 남긴다', () => {
    const store = createBuildingStore();
    store.getState().hydrate(island([chair('a', 0, 0)]));
    const history = createEditHistory(store, { limit: 3 });
    history.start();
    for (let x = 1; x <= 6; x++) {
      store.getState().updateObject('a', { position: { x, y: 0, z: 0 } });
      vi.advanceTimersByTime(300);
    }
    let steps = 0;
    while (history.undo()) steps++;
    expect(steps).toBe(3);
    expect(store.getState().objects[0]?.position.x).toBe(3);
  });

  it('멈추면 기록하지 않고, 다시 시작하면 그때 모습이 기준이다', () => {
    const store = createBuildingStore();
    store.getState().hydrate(island([]));
    const history = createEditHistory(store);
    history.start();
    history.stop();
    store.getState().addObject(chair('a', 0, 0));
    vi.advanceTimersByTime(300);
    expect(history.canUndo()).toBe(false);
    history.start();
    expect(history.undo()).toBe(false);
    expect(store.getState().objects).toHaveLength(1);
  });
});
