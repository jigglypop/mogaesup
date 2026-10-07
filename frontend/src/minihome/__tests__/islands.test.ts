import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBounds, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { beforeAll, describe, expect, it } from 'vitest';

import { BUILDING_TILE_PRESETS, type BuildingSerializedState, type PlacedObject, type TileConfig, type WallConfig } from 'gaesup-world/building';

import { shoreWalls } from '../coast';
import { islandFloors } from '../edit/catalog';
import { footprintsOverlap, type XZ } from '../edit/layout';
import { groundHeightAt, pickBoxOf, sizeOf, SIZE_RANGE, type LocalBox } from '../edit/objects';
import { ISLANDS, placeResidents, templateOf } from '../islands';
import { ISLAND_IDS } from '../islands/domain';
import { at, CELL, SIDE, SPAWN } from '../islands/kit';
import type { IslandTemplate } from '../islands/types';
import type { Resident } from '../residents';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const engine = resolve(dirname(fileURLToPath(import.meta.resolve('gaesup-world'))), '../public');
/** Where a model URL is served from: the app's public folder, or the engine's (Vite serves both). */
const fileOf = (url: string) => {
  const path = url.replace(/^\//, '');
  const own = resolve(frontend, 'public', path);
  return existsSync(own) ? own : resolve(engine, path);
};

const bounds = new Map<string, LocalBox>();
beforeAll(async () => {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const urls = new Set(ISLANDS.flatMap((template) => template.build().objects.flatMap((object) => (object.config?.modelUrl ? [object.config.modelUrl] : []))));
  for (const url of urls) {
    if (!existsSync(fileOf(url))) continue;
    const document = await io.read(fileOf(url));
    const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0]!;
    const box = getBounds(scene);
    bounds.set(url, { min: box.min, max: box.max });
  }
}, 60_000);

/** The island-prop catalog rows: `prop-<id>` with the label the drawer shows. */
const PROP_LABELS = new Map(
  [...readFileSync(resolve(frontend, '../server/migrations/20261005090000_island_props.sql'), 'utf8').matchAll(/\('(prop-[a-z0-9-]+)', 'furniture', '([^']+)'/g)].map(
    (match) => [match[1]!, match[2]!],
  ),
);

/** The island's ground runs from the west (north) edge of its first cell to the east (south) edge of its last. */
const [LOW, HIGH] = [at(0) - CELL / 2, at(SIDE - 1) + CELL / 2];
/**
 * What the forest has had since before there were kinds of island, kept as every home knew it: a tree on the pond's
 * shore and a rock in it, a lily drawn past the size steps, a fern against the cliff, chairs drawn in under the table,
 * the sign over the wardrobe, a log against a bush, and woods leaning over the miniroom's back wall.
 */
const FOREST_AS_BEFORE = new Set([
  'forest: sakura-2 stands in water',
  'forest: pond-rock-a stands in water',
  'forest: lily-b is 2.4× its size, past what the owner can change',
  'forest: edge-2-3 stands in raised ground tile-1-3',
  'forest: room-chair-a overlaps room-table',
  'forest: room-chair-b overlaps room-table',
  'forest: room-frame overlaps room-wardrobe',
  'forest: log-beach overlaps bush-c',
]);

const tilesOf = (state: BuildingSerializedState) => state.tileGroups.flatMap((group) => group.tiles);
const wallsOf = (state: BuildingSerializedState) => state.wallGroups.flatMap((group) => group.walls);
const isTree = (object: PlacedObject) => object.type === 'tree' || object.type === 'sakura' || /tree/.test(object.config?.modelId ?? '');
const walkable = (tile: TileConfig | undefined) =>
  !!tile && (tile.shape ?? 'box') === 'box' && tile.position.y === 0 && !['water', 'farm', 'snowfield'].includes(tile.objectType ?? 'none');
const tileAt = (state: BuildingSerializedState, x: number, z: number) =>
  tilesOf(state).find((tile) => Math.abs(tile.position.x - x) <= CELL / 2 && Math.abs(tile.position.z - z) <= CELL / 2);

/** A box in an object's frame, turned and moved onto the ground plane. */
function placed(object: { position: { x: number; z: number }; rotation?: number }, local: { min: readonly number[]; max: readonly number[] }): XZ[] {
  const c = Math.cos(object.rotation ?? 0);
  const s = Math.sin(object.rotation ?? 0);
  const corners: [number, number][] = [[local.min[0]!, local.min[2]!], [local.max[0]!, local.min[2]!], [local.max[0]!, local.max[2]!], [local.min[0]!, local.max[2]!]];
  return corners.map(([x, z]) => [object.position.x + c * x + s * z, object.position.z - s * x + c * z] as XZ);
}
const square = (x: number, z: number, half: number): XZ[] => [[x - half, z - half], [x + half, z - half], [x + half, z + half], [x - half, z + half]];

/** What an object covers on the ground: the whole model or crown (`reach`), or what stands on the ground (`base`). */
function footprint(object: PlacedObject, part: 'reach' | 'base'): XZ[] {
  const config = object.config ?? {};
  if (isTree(object) && part === 'base') return square(object.position.x, object.position.z, 0.4);
  if (object.type === 'billboard') {
    const half = (config.billboardWidth ?? 2) / 2;
    return placed(object, { min: [-half, 0, -0.06], max: [half, 0, 0.06] });
  }
  if (object.type === 'model') {
    const known = config.modelUrl ? bounds.get(config.modelUrl) : undefined;
    if (known) {
      const scale = config.modelScale ?? 1;
      return placed(object, { min: known.min.map((value) => value * scale), max: known.max.map((value) => value * scale) });
    }
  }
  return placed(object, pickBoxOf(object));
}
/** A wall's slab, by the engine's wall box: centered half a wall-length along its local Z from its pivot. */
function wallFootprint(wall: WallConfig): XZ[] {
  const angle = wall.rotation.y;
  const center = { x: wall.position.x + Math.sin(angle) * 2, z: wall.position.z + Math.cos(angle) * 2 };
  return placed({ position: center, rotation: angle }, { min: [-2, 0, -0.25], max: [2, 0, 0.25] });
}
const overlaps = (a: readonly XZ[], b: readonly XZ[], margin = 0) => {
  try {
    return footprintsOverlap(a, b, margin);
  } catch {
    return false;
  }
};

/** Everything wrong with a template's island, one line each. */
function problems(template: IslandTemplate): string[] {
  const state = template.build();
  const found: string[] = [];
  const say = (text: string) => found.push(`${template.id}: ${text}`);
  const tiles = tilesOf(state);
  const walls = wallsOf(state);
  const meshes = new Set(state.meshes.map((mesh) => mesh.id));
  const ids = [...tiles, ...walls, ...state.objects].map((item) => item.id);
  if (new Set(ids).size !== ids.length) say('ids repeat');
  if (state.version !== 1) say('version is not 1');
  const grid = new Set(Array.from({ length: SIDE }, (_, index) => at(index)));
  const cells = new Set<string>();
  for (const tile of tiles) {
    if (!grid.has(tile.position.x) || !grid.has(tile.position.z) || (tile.size ?? 1) !== 1) say(`${tile.id} is off the 14×14 grid`);
    cells.add(`${tile.position.x}:${tile.position.z}`);
    if (tile.materialId && !meshes.has(tile.materialId)) say(`${tile.id} paints with a missing mesh ${tile.materialId}`);
  }
  if (cells.size !== tiles.length || tiles.length !== SIDE * SIDE) say(`${tiles.length} tiles on ${cells.size} cells`);
  for (const group of state.wallGroups) {
    for (const mesh of [group.frontMeshId, group.backMeshId, group.sideMeshId]) if (mesh && !meshes.has(mesh)) say(`${group.id} uses a missing mesh ${mesh}`);
  }
  for (const group of state.tileGroups) if (group.floorMeshId && !meshes.has(group.floorMeshId)) say(`${group.id} floors with a missing mesh`);
  for (const floor of ['lawn', 'flowers', 'field', 'floor']) if (!meshes.has(floor)) say(`the drawer's ${floor} floor is missing`);

  // The start and the ground round it.
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!walkable(tileAt(state, SPAWN[0] + dx * CELL, SPAWN[2] + dz * CELL))) say(`the ground at the start (${dx}, ${dz}) is not open, flat ground`);
    }
  }
  const start = square(SPAWN[0], SPAWN[2], 2.2);
  for (const object of state.objects) if (overlaps(start, footprint(object, 'reach'))) say(`${object.id} stands within 2.2 m of the start`);
  for (const wall of walls) if (overlaps(start, wallFootprint(wall))) say(`${wall.id} stands within 2.2 m of the start`);

  // Each thing: a model that exists, on the ground, clear of walls, buildings and the other things.
  const raised = tiles.filter((tile) => tile.position.y > 0);
  for (const object of state.objects) {
    const config = object.config ?? {};
    const { x, y, z } = object.position;
    if (x < LOW || x > HIGH || z < LOW || z > HIGH) say(`${object.id} is off the island`);
    if (Math.abs(y - groundHeightAt(state.tileGroups, x, z)) > 1e-6) say(`${object.id} floats or sinks (${y} over ground ${groundHeightAt(state.tileGroups, x, z)})`);
    const under = tileAt(state, x, z);
    if (under?.objectType === 'water' && config.modelId !== 'nature-lily' && config.modelId !== 'prop-nature-lily') say(`${object.id} stands in water`);
    if (object.type === 'model') {
      const url = config.modelUrl ?? '';
      if (!/^\/?gltf\//.test(url) || !existsSync(fileOf(url))) say(`${object.id} has no model file (${url})`);
      if (config.modelId?.startsWith('prop-')) {
        if (PROP_LABELS.get(config.modelId) !== config.modelLabel) say(`${object.id} is labelled ${config.modelLabel}, the catalog says ${PROP_LABELS.get(config.modelId)}`);
        if (url !== `/gltf/decor/${config.modelId.slice(5)}.glb`) say(`${object.id} loads ${url} for ${config.modelId}`);
      }
      const size = sizeOf(object);
      if (size !== null && (size > SIZE_RANGE.max + 1e-6 || size < SIZE_RANGE.min - 1e-6)) say(`${object.id} is ${size}× its size, past what the owner can change`);
    }
    const base = footprint(object, 'base');
    for (const tile of raised) {
      if (tile.position.y > y + 1e-6 && overlaps(base, square(tile.position.x, tile.position.z, CELL / 2 - 0.05))) say(`${object.id} stands in raised ground ${tile.id}`);
    }
    const reach = footprint(object, isTree(object) ? 'reach' : 'base');
    for (const wall of walls) if (overlaps(reach, wallFootprint(wall), 0.05)) say(`${object.id} goes through ${wall.id}`);
  }
  for (let i = 0; i < state.objects.length; i++) {
    const a = state.objects[i]!;
    for (let j = 0; j < i; j++) {
      const b = state.objects[j]!;
      if (isTree(a) && isTree(b)) continue;
      if (overlaps(footprint(a, 'base'), footprint(b, 'base'))) say(`${a.id} overlaps ${b.id}`);
    }
  }

  // Arrival areas and rooms lie on the island.
  for (const box of [...template.areas, ...template.rooms]) {
    const [cx, , cz] = box.center;
    const [sx, , sz] = box.size;
    if (cx - sx / 2 < LOW - 1e-6 || cx + sx / 2 > HIGH + 1e-6 || cz - sz / 2 < LOW - 1e-6 || cz + sz / 2 > HIGH + 1e-6) say(`${box.id} reaches off the island`);
  }
  for (const rule of template.rules) {
    const trigger = rule.trigger as { areaId?: string };
    if (!template.areas.some((box) => box.id === trigger.areaId)) say(`${rule.id} listens for a missing area`);
  }

  // Resident spots: open, flat ground, clear of things, walls, the start and each other.
  if (template.residentSpots.length !== 12) say(`${template.residentSpots.length} resident spots`);
  template.residentSpots.forEach(([x, z], index) => {
    if (!walkable(tileAt(state, x, z))) say(`resident spot ${index} is not open ground`);
    const around = square(x, z, 1);
    for (const object of state.objects) if (overlaps(around, footprint(object, 'base'))) say(`resident spot ${index} is within 1 m of ${object.id}`);
    for (const wall of walls) if (overlaps(around, wallFootprint(wall))) say(`resident spot ${index} is within 1 m of ${wall.id}`);
    if (Math.hypot(x - SPAWN[0], z - SPAWN[2]) < 1.5) say(`resident spot ${index} is on the start`);
    template.residentSpots.slice(0, index).forEach(([ox, oz], other) => {
      if (Math.hypot(x - ox, z - oz) < 1) say(`resident spots ${other} and ${index} touch`);
    });
  });

  // The stand-ins for props still to come are on the island.
  for (const slot of template.slots) {
    if (slot.objects.length === 0) say(`slot ${slot.id} has no stand-in`);
    for (const id of slot.objects) if (!state.objects.some((object) => object.id === id)) say(`slot ${slot.id} names a missing ${id}`);
  }
  return found.filter((line) => !FOREST_AS_BEFORE.has(line));
}

describe('섬 종류', () => {
  it('여덟 가지가 모두 있고 각자 그림과 이름이 있다', () => {
    expect(ISLANDS.map((template) => template.id)).toEqual([...ISLAND_IDS]);
    for (const template of ISLANDS) {
      expect(template.label).not.toBe('');
      expect(template.picture).toBe(`/islands/${template.id}.webp`);
      expect(existsSync(resolve(frontend, 'public', template.picture.slice(1)))).toBe(true);
    }
  });

  it.each(ISLANDS.map((template) => [template.id, template] as const))('%s: 규칙을 지킨다', (_, template) => {
    expect(problems(template)).toEqual([]);
  });

  it.each(ISLANDS.map((template) => [template.id, template] as const))('%s: 매번 같은 섬을 만든다', (_, template) => {
    expect(JSON.stringify(template.build())).toBe(JSON.stringify(template.build()));
  });

  it.each(ISLANDS.map((template) => [template.id, template] as const))('%s: 저장 크기 안에 들고 NUL이 없다', (_, template) => {
    const text = JSON.stringify(template.build());
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(300 * 1024);
    expect(text.includes('\u0000')).toBe(false);
  });

  it.each(ISLANDS.map((template) => [template.id, template] as const))('%s: 바다와 만나는 곳마다 막혀 있고 시작점은 열려 있다', (_, template) => {
    const walls = shoreWalls(tilesOf(template.build()));
    expect(walls.length).toBeGreaterThan(0);
    const inside = (wall: (typeof walls)[number]) =>
      Math.abs(wall.position[0] - SPAWN[0]) < wall.halfExtents[0] && Math.abs(wall.position[2] - SPAWN[2]) < wall.halfExtents[2];
    expect(walls.some(inside)).toBe(false);
    // The island is whole, so the walls only ring it: none reaches in over its ground.
    for (const wall of walls) {
      const [x, , z] = wall.position;
      const [hx, , hz] = wall.halfExtents;
      expect(x + hx <= LOW + 1e-6 || x - hx >= HIGH - 1e-6 || z + hz <= LOW + 1e-6 || z - hz >= HIGH - 1e-6).toBe(true);
    }
  });

  it.each(ISLANDS.map((template) => [template.id, template] as const))('%s: 바닥 서랍에 이 섬의 땅이 모두 있다', (_, template) => {
    const state = template.build();
    const offered = new Set(islandFloors(state.meshes.map((mesh) => mesh.id)).map((floor) => floor.id));
    const ground = new Set(tilesOf(state).filter((tile) => tile.position.y === 0 && tile.materialId).map((tile) => tile.materialId!));
    expect([...ground].filter((id) => !offered.has(id))).toEqual([]);
  });

  it('바닥 프리셋 이름과 겹치는 섬 바닥은 없다', () => {
    const presets = new Set(BUILDING_TILE_PRESETS.map((preset) => preset.id));
    for (const template of ISLANDS) for (const mesh of template.build().meshes) expect(presets.has(mesh.id)).toBe(false);
  });

  it('바꾼 섬의 주민은 이름과 인사를 지키고 그 섬의 자리로 간다', () => {
    const residents: Resident[] = Array.from({ length: 3 }, (_, index) => ({
      id: `r${index}`, npc: 'npc-a', name: `주민${index}`, greeting: '안녕', position: [99, 3, 99], rotation: 1,
    }));
    const city = templateOf('city');
    const moved = placeResidents(residents, city);
    expect(moved.map((resident) => [resident.id, resident.name, resident.greeting])).toEqual(residents.map((resident) => [resident.id, resident.name, resident.greeting]));
    expect(moved.map((resident) => [resident.position[0], resident.position[2]])).toEqual(city.residentSpots.slice(0, 3));
    expect(moved.every((resident) => resident.position[1] === 0 && resident.rotation === 0)).toBe(true);
  });

  it('모르는 종류는 숲으로 본다', () => {
    expect(templateOf('nowhere' as never).id).toBe('forest');
  });
});
