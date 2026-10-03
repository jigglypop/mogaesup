import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBounds, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createBuildingStore, DEFAULT_BUILDING_OBJECT_CATALOG, type BuildingSerializedState } from 'gaesup-world/building';
import { createVillage, SPAWN } from '../village';
import { applyLayout, footprintsOverlap, interpretLayout, objectFootprint, proposeLayout, type LayoutCatalogItem, type XZ } from '../edit/layout';
import { createEditHistory } from '../edit/history';
import type { EditSession } from '../edit/session';
import type { LocalBox } from '../edit/objects';

// Vite serves public overrides before engine files. Read those actual GLBs with their node transforms,
// never invented dimensions. Production browser measurements also include the build's quantization.
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const engine = resolve(dirname(fileURLToPath(import.meta.resolve('gaesup-world'))), '../public');
let measured: LayoutCatalogItem[];
const bounds = new Map<string, LocalBox>();
const wanted = new Set(['table-basic', 'chair-basic', 'shop-stall-basic', 'storage-basic', 'lamp-basic']);
beforeAll(async () => {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const defaults = DEFAULT_BUILDING_OBJECT_CATALOG.filter(v => wanted.has(v.id));
  const village = createVillage();
  const urls = new Set([...defaults.map(v => v.modelUrl!), ...village.objects!.flatMap(v => v.config?.modelUrl ? [v.config.modelUrl] : [])]);
  for (const url of urls) {
    const override = resolve(frontend, 'public', url.replace(/^\//, ''));
    const path = existsSync(override) ? override : resolve(engine, url.replace(/^\//, ''));
    const document = await io.read(path);
    const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0]!;
    const value = getBounds(scene);
    expect(value.min.every(Number.isFinite)).toBe(true);
    bounds.set(url, { min: value.min, max: value.max });
  }
  measured = defaults.map(v => ({ id: v.id, label: v.label, modelUrl: v.modelUrl!, scale: v.defaultScale, color: v.defaultColor, bounds: bounds.get(v.modelUrl!)! }));
});

const island = () => {
  const store = createBuildingStore();
  store.getState().hydrate(createVillage());
  return { store, snapshot: store.getState().serialize() };
};
const proposal = (snapshot: BuildingSerializedState, text = '12m × 12m 카페 2인') => proposeLayout(snapshot, interpretLayout(text), measured,
  [SPAWN[0], SPAWN[2]], [[SPAWN[0], SPAWN[2]]], url => bounds.get(url));

describe('실제 섬 매장 자동 배치', () => {
  it('설명에서 업종, 4m 타일 개수, 좌석과 실제 바닥 프리셋을 고른다', () => {
    expect(interpretLayout('가로 10 세로 12 사무실 4인 콘크리트')).toMatchObject({ kind: 'office', widthCells: 3, depthCells: 3, seats: 4, floorPresetId: 'concrete', wallPresetId: 'modern-concrete' });
    expect(interpretLayout('3×4칸 커피 매장')).toMatchObject({ kind: 'cafe', widthCells: 3, depthCells: 4 });
    expect(() => interpretLayout('40m x 12m 매장')).toThrow('8m');
    expect(() => interpretLayout('13인 카페')).toThrow('좌석');
  });

  it('minihome-v6의 기물·실제 GLB 경계를 보존하며 12m 카페 2석이 생성된다', () => {
    const { snapshot } = island(), original = structuredClone(snapshot);
    const plan = proposal(snapshot);
    expect(snapshot).toEqual(original); // Preview never edits the live snapshot.
    expect(plan.snapshot.objects.slice(0, original.objects.length)).toEqual(original.objects);
    expect(plan.snapshot.blocks).toEqual(original.blocks);
    expect(plan.snapshot.wallGroups.slice(0, original.wallGroups.length)).toEqual(original.wallGroups);
    expect(plan.objects.filter(v => v.config?.modelId === 'chair-basic')).toHaveLength(2);
    expect(plan.walls).toHaveLength(11);
    expect(plan.walls.every(v => v.wall.wallKind === 'solid')).toBe(true);
    expect(plan.walls.some(v => v.center[0] === plan.entrance[0] && v.center[1] === plan.entrance[1])).toBe(false);
    expect(plan.floor.max[0] - plan.floor.min[0]).toBe(12);
    const aisle: XZ[] = [[plan.corridorX - .75, plan.corridor.minZ], [plan.corridorX + .75, plan.corridor.minZ], [plan.corridorX + .75, plan.corridor.maxZ], [plan.corridorX - .75, plan.corridor.maxZ]];
    const newBoxes = plan.objects.map(v => objectFootprint(v, bounds.get(v.config!.modelUrl!)!));
    for (let i = 0; i < newBoxes.length; i++) {
      expect(footprintsOverlap(newBoxes[i]!, aisle, .15)).toBe(false);
      for (let j = 0; j < i; j++) expect(footprintsOverlap(newBoxes[i]!, newBoxes[j]!, .15)).toBe(false);
      for (const object of original.objects) expect(footprintsOverlap(newBoxes[i]!, objectFootprint(object, object.config?.modelUrl ? bounds.get(object.config.modelUrl) : undefined), .15)).toBe(false);
    }
    expect(plan.objects.every(v => Number.isInteger(v.position.x) && Number.isInteger(v.position.z))).toBe(true);
    const preserved = new Map(plan.snapshot.tileGroups.flatMap(v => v.tiles).map(v => [v.id, v]));
    for (const tile of original.tileGroups.flatMap(v => v.tiles)) expect(preserved.get(tile.id)?.position).toEqual(tile.position);
  });

  it.each(['12m×12m 소품 매장', '12m×12m 사무실 2인'])('%s도 실제 카탈로그로 배치된다', text => {
    const { snapshot } = island();
    const plan = proposal(snapshot, text);
    expect(plan.objects.length).toBeGreaterThan(0);
    expect(plan.objects.every(v => measured.some(item => item.id === v.config?.modelId))).toBe(true);
  });

  it('적용은 한 undo 단계이고 재검수 중 섬이 바뀌면 적용하지 않는다', () => {
    const { store, snapshot } = island(), plan = proposal(snapshot);
    const history = createEditHistory(store); history.start();
    const changed = vi.fn(); const unsubscribe = store.subscribe(changed);
    const session = { runtime: { buildingStore: store, save: { getBindings: () => [{ key: 'building', serialize: () => store.getState().serialize() }] } },
      history, getState: () => ({ active: true }), setTool: vi.fn(), select: vi.fn(), setPivot: vi.fn() } as unknown as EditSession;
    applyLayout(session, plan);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(store.getState().objects.length).toBe(snapshot.objects.length + plan.objects.length);
    expect(history.undo()).toBe(true);
    expect(store.getState().serialize().objects).toEqual(snapshot.objects);
    expect(history.canUndo()).toBe(false);
    expect(history.redo()).toBe(true);
    expect(() => applyLayout(session, plan)).toThrow('섬이 바뀌었어요');
    unsubscribe(); history.stop();
  });

  it('측정되지 않은 기존 모델을 가정해 배치하지 않는다', () => {
    const { snapshot } = island();
    expect(() => proposeLayout(snapshot, interpretLayout('카페'), measured, [0, 0])).toThrow('기존 기물');
  });
});
