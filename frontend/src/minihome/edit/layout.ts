import {
  BUILDING_TILE_PRESETS, BUILDING_WALL_PRESETS, DEFAULT_BUILDING_OBJECT_CATALOG,
  createBuildingScopeId, edgeToWallTransform,
  type BuildingSerializedState, type PlacedObject, type TileConfig, type WallConfig,
} from 'gaesup-world/building';

import { loadModelBounds } from './bounds';
import { pickBoxOf, type LocalBox } from './objects';
import type { EditSession } from './session';

export type LayoutIntent = {
  kind: 'cafe' | 'shop' | 'office'; widthCells: number; depthCells: number; seats: number;
  floorPresetId: string; wallPresetId: string; interpretation: 'rules' | 'ai'; warnings: string[];
};
export type LayoutCatalogItem = { id: string; label: string; modelUrl: string; scale: number; color: string; bounds: LocalBox };
export type XZ = readonly [number, number];
export type LayoutWall = { wall: WallConfig; center: XZ; alongX: boolean; color: string };
export type LayoutProposal = {
  id: string; baseline: string; snapshot: BuildingSerializedState; intent: LayoutIntent;
  objects: PlacedObject[]; walls: LayoutWall[]; floor: { min: XZ; max: XZ; color: string };
  entrance: XZ; corridorX: number; measured: LayoutCatalogItem[]; notice: string[];
  corridor: { minZ: number; maxZ: number };
};
const MAX_BYTES = 2 * 1024 * 1024;
const EPS = 1e-6;
const MARGIN = 0.15;
const CORRIDOR_HALF = 0.75;

/** A layout refused for a reason the owner can act on, said in their words (unlike a loader's or the browser's). */
export class LayoutError extends Error {}

/** Free parsing stays in the browser, including when the studio is asleep. */
export function interpretLayout(description: string): LayoutIntent {
  const text = description.trim().toLowerCase();
  if (!text || text.length > 2000) throw new LayoutError('공간 설명을 2,000자 이내로 입력해 주세요.');
  const kind = /사무|오피스|office|회사/.test(text) ? 'office' : /카페|커피|cafe|café/.test(text) ? 'cafe' : 'shop';
  let width = 12, depth = 12;
  const pair = text.match(/(\d+(?:\.\d+)?)\s*(?:m|미터)?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(m|미터|칸)?/);
  if (pair) {
    const unit = pair[3] === '칸' ? 4 : 1;
    width = Number(pair[1]) * unit; depth = Number(pair[2]) * unit;
  } else {
    width = Number(text.match(/가로\s*(\d+(?:\.\d+)?)/)?.[1] ?? 12);
    depth = Number(text.match(/세로\s*(\d+(?:\.\d+)?)/)?.[1] ?? 12);
  }
  if (width < 8 || depth < 8 || width > 24 || depth > 24) throw new LayoutError('가로·세로는 8m부터 24m까지 배치할 수 있어요.');
  const seats = Number(text.match(/(\d+)\s*(?:인|명|석|좌석)/)?.[1] ?? (kind === 'shop' ? 0 : 2));
  if (!Number.isInteger(seats) || seats < 0 || seats > 12) throw new LayoutError('좌석은 0개부터 12개까지 입력해 주세요.');
  const floorPresetId = /대리석|marble/.test(text) ? 'white-marble' : /콘크리트|concrete/.test(text) ? 'concrete' : /어두운|월넛|walnut/.test(text) ? 'walnut-planks' : 'oak-planks';
  return { kind, widthCells: Math.ceil(width / 4), depthCells: Math.ceil(depth / 4), seats, floorPresetId,
    wallPresetId: kind === 'office' ? 'modern-concrete' : 'shopfront', interpretation: 'rules',
    warnings: width % 4 || depth % 4 ? [`4m 타일에 맞춰 ${Math.ceil(width / 4) * 4}m × ${Math.ceil(depth / 4) * 4}m로 배치해요.`] : [] };
}

export function checkLayoutIntent(intent: LayoutIntent): void {
  if (!['cafe', 'shop', 'office'].includes(intent.kind) || ![intent.widthCells, intent.depthCells].every(v => Number.isInteger(v) && v >= 2 && v <= 6)
    || !Number.isInteger(intent.seats) || intent.seats < 0 || intent.seats > 12
    || !BUILDING_TILE_PRESETS.some(v => v.id === intent.floorPresetId) || !BUILDING_WALL_PRESETS.some(v => v.id === intent.wallPresetId)) {
    throw new LayoutError('배치 조건이 올바르지 않아요. 설명을 다시 입력해 주세요.');
  }
}

/**
 * Every extent comes from the GLB the current browser actually decodes, including overrides/quantization: the pieces
 * the planner places, and `extraUrls` (the island's placed models, its obstacles). Not the whole furniture catalog, whose
 * dozens of studio models the planner never places and would all be downloaded and decoded for each proposal. A placed
 * model that cannot be measured stays unknown, and `proposeLayout` refuses to guess its footprint in the owner's words.
 */
export async function measureLayoutCatalog(extraUrls: readonly string[] = [], kind?: LayoutIntent['kind']): Promise<LayoutCatalogItem[]> {
  const wanted = new Set(['table-basic', 'chair-basic', 'shop-stall-basic', 'storage-basic', 'lamp-basic']);
  const items: LayoutCatalogItem[] = DEFAULT_BUILDING_OBJECT_CATALOG.filter(item => wanted.has(item.id) && !!item.modelUrl)
    .map(item => ({ id: item.id, label: item.label, modelUrl: item.modelUrl!, scale: item.defaultScale, color: item.defaultColor, bounds: undefined! }));
  // The studio furniture this kind may place: only those, so a proposal downloads what it can use.
  for (const prop of kind ? storeProps(kind) : []) {
    if (items.some(item => item.id === propCatalogId(prop.id))) continue;
    items.push({ id: propCatalogId(prop.id), label: prop.label, modelUrl: storePropUrl(prop.id), scale: 1, color: '#ffffff', bounds: undefined! });
  }
  await Promise.all([...new Set(extraUrls)].map(url => loadModelBounds(url).catch(() => undefined)));
  return Promise.all(items.map(async item => ({ ...item, bounds: await loadModelBounds(item.modelUrl) })));
}

/**
 * Studio furniture made with scripts/props, per kind, in the order the layout tries to place it after its core pieces:
 * each where it fits and skipped where it does not. They are built-in catalog items (`prop-<id>`, see
 * server/migrations/20261011190000_store_props.sql) and are placed the way the decorating drawer places them.
 */
const STORE_PROPS: Record<LayoutIntent['kind'], { id: string; label: string; at: StoreSpot }[]> = {
  cafe: [
    { id: 'cafe-counter', label: '카페 카운터', at: 'back' },
    { id: 'cafe-espresso-machine', label: '커피 머신', at: 'backRight' },
    { id: 'cafe-bread-showcase', label: '빵 진열장', at: 'right' },
    { id: 'cafe-menu-board', label: '메뉴 입간판', at: 'frontLeft' },
    { id: 'plant-big-pot', label: '큰 화분', at: 'backLeft' },
    { id: 'rug-round', label: '러그', at: 'center' },
  ],
  shop: [
    { id: 'shop-checkout', label: '계산대', at: 'front' },
    { id: 'shop-wall-shelf', label: '벽 진열 선반', at: 'left' },
    { id: 'shop-wall-shelf', label: '벽 진열 선반', at: 'right' },
    { id: 'shop-clothes-rack', label: '옷걸이 행거', at: 'backRight' },
    { id: 'shop-produce-stand', label: '과일·채소 진열대', at: 'right' },
    { id: 'shop-basket-stand', label: '바구니 진열대', at: 'frontRight' },
    { id: 'plant-big-pot', label: '큰 화분', at: 'backLeft' },
    { id: 'rug-round', label: '러그', at: 'center' },
  ],
  office: [
    { id: 'office-bookshelf', label: '책장', at: 'left' },
    { id: 'office-whiteboard', label: '화이트보드', at: 'right' },
    { id: 'office-water-cooler', label: '정수기', at: 'frontRight' },
    { id: 'sofa-two-seat', label: '2인 소파', at: 'back' },
    { id: 'plant-big-pot', label: '큰 화분', at: 'backLeft' },
    { id: 'rug-round', label: '러그', at: 'center' },
  ],
};
type StoreSpot = 'back' | 'front' | 'left' | 'right' | 'backLeft' | 'backRight' | 'frontLeft' | 'frontRight' | 'center';
const storeProps = (kind: LayoutIntent['kind']) => STORE_PROPS[kind];
/** Every studio piece a layout may place, once each (for tools that measure them ahead of time). */
export const STORE_PROP_IDS = [...new Set(Object.values(STORE_PROPS).flat().map(prop => prop.id))];
const propCatalogId = (id: string) => `prop-${id}`;
const storePropUrl = (id: string) => `/gltf/decor/${id}.glb`;
/** Where a store piece is wanted inside the room, as a point the scan starts from (a wall or a corner, or the centre). */
const spotOf = (at: StoreSpot, min: XZ, max: XZ): XZ => {
  const mid: XZ = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
  switch (at) {
    case 'back': return [mid[0], min[1] + 1];
    case 'front': return [mid[0], max[1] - 1];
    case 'left': return [min[0] + 1, mid[1]];
    case 'right': return [max[0] - 1, mid[1]];
    case 'backLeft': return [min[0] + 1, min[1] + 1];
    case 'backRight': return [max[0] - 1, min[1] + 1];
    case 'frontLeft': return [min[0] + 1, max[1] - 1];
    case 'frontRight': return [max[0] - 1, max[1] - 1];
    case 'center': return mid;
  }
}

export function objectFootprint(object: PlacedObject, bounds?: LocalBox): XZ[] {
  // pickBoxOf multiplies real decoded geometry by the stored modelScale. Procedural pieces use their authored extent.
  const local = object.type === 'model' && bounds ? {
    min: bounds.min.map(v => v * (object.config?.modelScale ?? 1)),
    max: bounds.max.map(v => v * (object.config?.modelScale ?? 1)),
  } : pickBoxOf(object);
  const c = Math.cos(object.rotation ?? 0), s = Math.sin(object.rotation ?? 0);
  return [[local.min[0]!, local.min[2]!], [local.max[0]!, local.min[2]!], [local.max[0]!, local.max[2]!], [local.min[0]!, local.max[2]!]]
    .map(([x, z]) => [object.position.x + c * x! + s * z!, object.position.z - s * x! + c * z!] as XZ);
}

const rect = (x0: number, z0: number, x1: number, z1: number): XZ[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
export function footprintsOverlap(a: readonly XZ[], b: readonly XZ[], margin = 0): boolean {
  for (const poly of [a, b]) for (let i = 0; i < poly.length; i++) {
    const from = poly[i]!, to = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (len < EPS) throw new LayoutError('기물 크기를 측정할 수 없어요.');
    const axis: XZ = [-(to[1] - from[1]) / len, (to[0] - from[0]) / len];
    const left = a.map(v => v[0] * axis[0] + v[1] * axis[1]), right = b.map(v => v[0] * axis[0] + v[1] * axis[1]);
    if (Math.max(...left) + margin <= Math.min(...right) + EPS || Math.max(...right) + margin <= Math.min(...left) + EPS) return false;
  }
  return true;
}

const validFloor = (tile: TileConfig) => (tile.size ?? 1) === 1 && (tile.shape ?? 'box') === 'box' && tile.position.y === 0
  && !['water', 'farm', 'snowfield'].includes(tile.objectType ?? 'none');
const sameSnapshot = (value: BuildingSerializedState) => JSON.stringify(value);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export function proposeLayout(snapshot: BuildingSerializedState, intent: LayoutIntent, measured: readonly LayoutCatalogItem[],
  anchor: XZ, protectedPoints: readonly XZ[] = [], knownBounds: (url: string) => LocalBox | undefined = () => undefined): LayoutProposal {
  checkLayoutIntent(intent);
  const catalog = new Map(measured.map(item => [item.id, item]));
  const allTiles = snapshot.tileGroups.flatMap(group => group.tiles);
  const cells = new Map(allTiles.filter(validFloor).map(tile => [`${tile.position.x}:${tile.position.z}`, tile]));
  const allCells = new Map(allTiles.map(tile => [`${tile.position.x}:${tile.position.z}`, tile]));
  // Tiles that can cover a 4 m cell other than their own: larger ones, and any off the grid. A one-cell tile on the grid
  // covers only its own cell, which `allCells` already answers, so the per-cell scan below runs over these few alone.
  const spanning = allTiles.filter(tile => (tile.size ?? 1) !== 1 || tile.position.x % 4 !== 0 || tile.position.z % 4 !== 0);
  const existing = snapshot.objects.map(object => {
    const bounds = object.config?.modelUrl ? knownBounds(object.config.modelUrl) : undefined;
    if (object.type === 'model' && !bounds) throw new LayoutError('기존 기물의 크기를 확인하지 못했어요. 다시 배치해 주세요.');
    return objectFootprint(object, bounds);
  });
  const blockBounds = snapshot.blocks.map(block => rect(block.position.x - 2, block.position.z - 2,
    block.position.x - 2 + 4 * (block.size?.x ?? 1), block.position.z - 2 + 4 * (block.size?.z ?? 1)));
  // A wall pivot is half a wall-length behind its center along local Z, as the engine's wallBox contract specifies.
  const existingWalls = snapshot.wallGroups.flatMap(group => group.walls).map(wall => {
    const angle = wall.rotation.y, cx = wall.position.x + Math.sin(angle) * 2, cz = wall.position.z + Math.cos(angle) * 2;
    const c = Math.cos(angle), s = Math.sin(angle);
    return rect(-2, -.25, 2, .25).map(([x, z]) => [cx + c * x + s * z, cz - s * x + c * z] as XZ);
  });
  const obstacles = [...existing, ...blockBounds, ...existingWalls, ...protectedPoints.map(([x, z]) => rect(x - 1.5, z - 1.5, x + 1.5, z + 1.5))];
  const floorPreset = BUILDING_TILE_PRESETS.find(v => v.id === intent.floorPresetId)!;
  const wallPreset = BUILDING_WALL_PRESETS.find(v => v.id === intent.wallPresetId)!;
  const candidates: { position: { x: number; z: number } }[] = [];
  for (let z = -40; z <= 40 - (intent.depthCells - 1) * 4; z += 4) for (let x = -40; x <= 40 - (intent.widthCells - 1) * 4; x += 4) candidates.push({ position: { x, z } });
  candidates.sort((a, b) => Math.hypot(a.position.x + (intent.widthCells - 1) * 2 - anchor[0], a.position.z + (intent.depthCells - 1) * 2 - anchor[1])
    - Math.hypot(b.position.x + (intent.widthCells - 1) * 2 - anchor[0], b.position.z + (intent.depthCells - 1) * 2 - anchor[1]));
  for (const start of candidates) {
    const x0 = start.position.x, z0 = start.position.z;
    const min: XZ = [x0 - 2, z0 - 2], max: XZ = [x0 + intent.widthCells * 4 - 2, z0 + intent.depthCells * 4 - 2];
    const region = rect(min[0] - .25, min[1] - .25, max[0] + .25, max[1] + .25);
    if (obstacles.some(box => footprintsOverlap(region, box, MARGIN))) continue;
    const selected: TileConfig[] = [];
    const added: TileConfig[] = [];
    for (let z = 0; z < intent.depthCells; z++) for (let x = 0; x < intent.widthCells; x++) {
      const tile = cells.get(`${x0 + x * 4}:${z0 + z * 4}`);
      if (tile) selected.push(tile);
      else if (!allCells.has(`${x0 + x * 4}:${z0 + z * 4}`) && !spanning.some(v => Math.abs(v.position.x - x0 - x * 4) < (v.size ?? 1) * 2 && Math.abs(v.position.z - z0 - z * 4) < (v.size ?? 1) * 2)) {
        const created: TileConfig = { id: createBuildingScopeId('tile'), tileGroupId: '', position: { x: x0 + x * 4, y: 0, z: z0 + z * 4 }, size: 1, shape: 'box', objectType: 'none' };
        selected.push(created); added.push(created);
      }
    }
    if (selected.length !== intent.widthCells * intent.depthCells) continue;
    const corridorX = x0 + Math.floor(intent.widthCells / 2) * 4;
    let entranceSide: 'north' | 'south' | null = null;
    for (const side of ['south', 'north'] as const) {
      const outsideZ = side === 'south' ? z0 + intent.depthCells * 4 : z0 - 4;
      const edgeZ = side === 'south' ? max[1] : min[1];
      if (cells.has(`${corridorX}:${outsideZ}`) && !obstacles.some(box => footprintsOverlap(rect(corridorX - .9, Math.min(edgeZ, outsideZ), corridorX + .9, Math.max(edgeZ, outsideZ)), box, MARGIN))) { entranceSide = side; break; }
    }
    if (!entranceSide) continue;
    const entrance: XZ = [corridorX, entranceSide === 'south' ? max[1] : min[1]];
    const corridor = { minZ: entranceSide === 'north' ? min[1] : z0, maxZ: entranceSide === 'south' ? max[1] : max[1] - 2 };
    const planId = createBuildingScopeId('layout');
    const objects: PlacedObject[] = [];
    const occupied: XZ[][] = [];
    const interior = { min: [min[0] + .25 + MARGIN, min[1] + .25 + MARGIN] as XZ, max: [max[0] - .25 - MARGIN, max[1] - .25 - MARGIN] as XZ };
    const aisle = rect(corridorX - CORRIDOR_HALF, corridor.minZ, corridorX + CORRIDOR_HALF, corridor.maxZ);
    const make = (id: string, x: number, z: number, rotation = 0): PlacedObject => {
      const item = catalog.get(id);
      if (!item) throw new LayoutError('배치에 필요한 기물이 없어요. 카탈로그를 다시 불러와 주세요.');
      return { id: createBuildingScopeId('obj'), type: 'model', position: { x, y: 0, z }, rotation,
        config: { modelId: item.id, modelLabel: item.label, modelUrl: item.modelUrl, modelScale: item.scale, modelColor: item.color } };
    };
    const boxOf = (object: PlacedObject) => objectFootprint(object, catalog.get(object.config!.modelId!)!.bounds);
    const fits = (object: PlacedObject, extra: readonly XZ[][] = []) => {
      const box = boxOf(object);
      return box.every(([x, z]) => x >= interior.min[0] && x <= interior.max[0] && z >= interior.min[1] && z <= interior.max[1])
        && !footprintsOverlap(box, aisle, MARGIN) && ![...occupied, ...extra].some(v => footprintsOverlap(box, v, MARGIN));
    };
    const keep = (object: PlacedObject) => { objects.push(object); occupied.push(boxOf(object)); };
    const scan = (id: string, prefer: XZ, rotation = 0): PlacedObject | null => {
      const spots: XZ[] = [];
      for (let z = Math.ceil(interior.min[1]); z <= Math.floor(interior.max[1]); z++) for (let x = Math.ceil(interior.min[0]); x <= Math.floor(interior.max[0]); x++) spots.push([x, z]);
      spots.sort((a, b) => Math.hypot(a[0] - prefer[0], a[1] - prefer[1]) - Math.hypot(b[0] - prefer[0], b[1] - prefer[1]));
      for (const [x, z] of spots) { const object = make(id, x, z, rotation); if (fits(object)) return object; }
      return null;
    };
    if (intent.kind !== 'office') {
      const counter = scan('shop-stall-basic', [max[0] - 2, z0], Math.PI / 2);
      if (!counter) continue;
      keep(counter);
    }
    let remaining = intent.seats;
    const tablesNeeded = intent.kind === 'office' ? remaining : Math.ceil(remaining / 2);
    for (let tableIndex = 0; tableIndex < tablesNeeded; tableIndex++) {
      const seats = Math.min(intent.kind === 'office' ? 1 : 2, remaining);
      let group: PlacedObject[] | null = null;
      const tableSpots: XZ[] = [];
      for (let z = Math.ceil(interior.min[1] + 2); z <= Math.floor(interior.max[1] - 2); z++) for (let x = Math.ceil(interior.min[0] + 1.5); x <= Math.floor(interior.max[0] - 1.5); x++) tableSpots.push([x, z]);
      tableSpots.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      for (const [x, z] of tableSpots) {
        const table = make('table-basic', x, z, Math.PI / 2);
        const chairs = seats === 1 ? [make('chair-basic', x, z + 2, Math.PI)] : [make('chair-basic', x, z - 2), make('chair-basic', x, z + 2, Math.PI)];
        const current = [table, ...chairs];
        if (current.every((item, index) => fits(item, current.slice(0, index).map(boxOf)))) { group = current; break; }
      }
      if (!group) break;
      group.forEach(keep); remaining -= seats;
    }
    if (remaining) continue;
    if (intent.kind === 'shop') for (let i = 0; i < 3; i++) {
      const shelf = scan('storage-basic', [x0, z0 + i * 4]);
      if (shelf) keep(shelf);
    }
    const lamp = scan('lamp-basic', [max[0] - 1, max[1] - 1]);
    if (lamp) keep(lamp);
    // Studio furniture for the kind, where there is room for it (the core pieces above come first).
    for (const prop of storeProps(intent.kind)) {
      const id = propCatalogId(prop.id);
      if (!catalog.has(id)) continue;
      const piece = scan(id, spotOf(prop.at, min, max));
      if (piece) keep(piece);
    }
    const walls: LayoutWall[] = [];
    const wallGroupId = `${planId}-walls`;
    const wallMeshId = `${planId}-wall`;
    for (const tile of selected) {
      const x = tile.position.x, z = tile.position.z;
      const sides: ('north' | 'east' | 'south' | 'west')[] = [];
      if (z === z0) sides.push('north');
      if (z === z0 + (intent.depthCells - 1) * 4) sides.push('south');
      if (x === x0) sides.push('west');
      if (x === x0 + (intent.widthCells - 1) * 4) sides.push('east');
      for (const side of sides) {
        // This engine version draws a static door leaf for both door and arch kinds.
        // Leave the complete entrance segment open so the preview and playable result agree.
        if (side === entranceSide && x === corridorX) continue;
        const transform = edgeToWallTransform({ x: x / 4, z: z / 4, level: 0, side });
        const center: XZ = [x + (side === 'west' ? -2 : side === 'east' ? 2 : 0), z + (side === 'north' ? -2 : side === 'south' ? 2 : 0)];
        walls.push({ wall: { id: createBuildingScopeId('wall'), wallGroupId, position: transform.position,
          rotation: { x: 0, y: transform.rotationY, z: 0 }, wallKind: 'solid' }, center, alongX: side === 'north' || side === 'south', color: wallPreset.interiorColor });
      }
    }
    const next = structuredClone(snapshot);
    const selectedIds = new Set(selected.map(v => v.id));
    const floorMeshId = `${planId}-floor`;
    next.meshes.push({ id: floorMeshId, color: floorPreset.color, roughness: floorPreset.roughness ?? .8, metalness: floorPreset.metalness ?? 0,
      ...(floorPreset.mapTextureUrl ? { mapTextureUrl: floorPreset.mapTextureUrl } : {}) }, { id: wallMeshId, color: wallPreset.interiorColor, roughness: wallPreset.roughness ?? .8 });
    for (const group of next.tileGroups) for (const tile of group.tiles) if (selectedIds.has(tile.id)) {
      tile.materialId = floorMeshId; tile.objectType = 'none'; delete tile.objectConfig;
    }
    if (added.length) {
      const groupId = `${planId}-tiles`;
      next.tileGroups.push({ id: groupId, name: '매장 바닥', floorMeshId, tiles: added.map(tile => ({ ...tile, tileGroupId: groupId, materialId: floorMeshId })) });
    }
    next.wallGroups.push({ id: wallGroupId, name: intent.kind === 'office' ? '사무실' : intent.kind === 'cafe' ? '카페' : '매장',
      frontMeshId: wallMeshId, backMeshId: wallMeshId, sideMeshId: wallMeshId, walls: walls.map(v => v.wall) });
    next.objects.push(...objects);
    if (bytes(next) > MAX_BYTES - 64 * 1024) throw new LayoutError('섬의 저장 공간이 부족해요. 기물을 줄인 뒤 다시 배치해 주세요.');
    return { id: planId, baseline: sameSnapshot(snapshot), snapshot: next, intent, objects, walls, floor: { min, max, color: floorPreset.color },
      entrance, corridorX, corridor, measured: [...measured], notice: [...intent.warnings] };
  }
  throw new LayoutError(`${intent.widthCells * 4}m × ${intent.depthCells * 4}m의 빈 땅과 출입 경로가 없어요.`);
}

/** One synchronous prepared mutation; the live store and autosaver see no preview writes. */
export function applyLayout(session: EditSession, proposal: LayoutProposal): void {
  if (!session.getState().active) throw new LayoutError('꾸미기를 다시 열어 주세요.');
  const state = session.runtime.buildingStore.getState();
  if (sameSnapshot(state.serialize()) !== proposal.baseline) throw new LayoutError('섬이 바뀌었어요. 배치를 다시 만들어 주세요.');
  const domains: Record<string, unknown> = {};
  for (const binding of session.runtime.save.getBindings()) domains[binding.key] = binding.key === 'building' ? proposal.snapshot : binding.serialize();
  if (bytes({ version: 1, savedAt: Date.now(), domains }) > MAX_BYTES) throw new LayoutError('섬의 저장 공간이 부족해요.');
  const apply = state.prepareHydrate(proposal.snapshot);
  session.history.flush();
  const release = session.history.hold();
  try { apply(); } finally { release(); }
  session.setTool('select');
  session.select(proposal.objects[0]?.id ?? null);
  session.setPivot((proposal.floor.min[0] + proposal.floor.max[0]) / 2, (proposal.floor.min[1] + proposal.floor.max[1]) / 2);
}
