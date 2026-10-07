import type { GameplayAreaConfig, GameplayEventBlueprint } from 'gaesup-world';
import {
  edgeToWallTransform,
  getDefaultBuildingObject,
  type BuildingTreeKind,
  type BuildingWallKind,
  type FlagStyle,
  type MeshConfig,
  type MeshScatterConfig,
  type PlacedObject,
  type TileConfig,
  type TileGroupConfig,
  type WallConfig,
} from 'gaesup-world/building';

import type { IslandSlot } from './types';

/** Grid cell in meters; one character (1.7m) is a little under half a cell. */
export const CELL = 4;
/** Every island is this many cells a side. */
export const SIDE = 14;
const HALF = (SIDE * CELL) / 2;

/** Center of cell `index` on either axis: on the building grid, so tiles the 꾸미기 tab adds line up with these. */
export const at = (index: number) => index * CELL - HALF;

/** The cell every island's player starts on, and around which it keeps open ground. */
export const SPAWN_CELL = [8, 5] as const;
/** Where the player starts, a little over the ground so the body settles onto it. */
export const SPAWN: [number, number, number] = [at(SPAWN_CELL[0]), 1, at(SPAWN_CELL[1])];

// Small SVG textures, each drawn at 4m scale. The engine lays them in world space, one picture per 4 m from each cell's
// centre, rows running north as y grows: a cell's centre lines fall on a picture's edges, the cell's own edges on its
// middle (x or y = 64). Patterns that repeat every 128 / n px look the same either way.
export const svg = (body: string, background: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" fill="${background}"/>${body}</svg>`,
  )}`;
export const scatter = (count: number, seed: number, draw: (x: number, y: number, i: number) => string) =>
  Array.from({ length: count }, (_, i) => {
    const r = (n: number) => Math.abs(Math.sin((i + 1) * 12.9898 + seed * 78.233 + n) * 43758.5453) % 1;
    return draw(Math.round(r(1) * 120) + 4, Math.round(r(2) * 120) + 4, i);
  }).join('');

/** A stable number in [0, 1) per cell and salt, so an island looks the same on every visit. */
export const noise = (x: number, z: number, salt: number) => Math.abs((Math.sin((x * 31 + z * 17 + salt) * 12.9898) * 43758.5453) % 1);

// One even green: a checker per tile made the whole island read as a board. The lawn layer's blades carry the detail.
export const LAWN = svg(
  scatter(14, 1, (x, y) => `<path d="M${x} ${y}l-2 -5M${x} ${y}l2 -5" stroke="#80bf5b" stroke-width="2" stroke-linecap="round"/>`),
  '#8ccd65',
);
export const FLOWERS = svg(
  scatter(40, 3, (x, y, i) => {
    const petal = ['#ff8fb1', '#ffffff', '#ffb3c9', '#fff3a8'][i % 4];
    return `<circle cx="${x}" cy="${y}" r="5" fill="${petal}"/><circle cx="${x}" cy="${y}" r="2" fill="#ffc53d"/>`;
  }),
  '#6fbf53',
);
export const FIELD = svg(
  [16, 48, 80, 112].map((y) => `<rect x="6" y="${y - 9}" width="116" height="18" rx="9" fill="#6b4529"/>`).join('') +
    [16, 48, 80, 112].map((y) => [20, 44, 68, 92, 112].map((x) => `<path d="M${x} ${y}c-6-8-2-12 0-12c2 0 6 4 0 12zM${x} ${y}c6-6 10-4 8 0" fill="#5fbf45"/>`).join('')).join(''),
  '#8a5f3a',
);
export const PLANKS = svg([0, 32, 64, 96].map((y, i) => `<rect y="${y}" width="128" height="31" fill="${i % 2 ? '#d9ab73' : '#d3a36a'}"/><path d="M${40 + i * 24} ${y}v31" stroke="#b98a52" stroke-width="2"/>`).join(''), '#b98a52');

/** Flowers, stones and shrubs along the roads, and now and then a mushroom or fern out on the lawn. */
export const LAWN_DECOR: MeshScatterConfig[] = [
  {
    models: ['nature-flower-yellow', 'nature-flower-red', 'nature-flower-purple', 'nature-flower-yellow', 'nature-rock-small', 'nature-bush'],
    density: 0.9, near: 'dirt', margin: 0.35, within: 1.7, clump: 0.7, scale: [0.7, 1.1],
  },
  { models: ['nature-mushroom-cluster', 'nature-rock-flat', 'nature-fern'], density: 0.05, clump: 0.5, scale: [0.7, 1] },
];
export const LAWN_MESH: MeshConfig = { id: 'lawn', color: '#ffffff', mapTextureUrl: LAWN, roughness: 0.95, grass: { profile: 'lawn', color: '#86c460' }, scatter: LAWN_DECOR };

/** Floors every island holds, so the decorating drawer's lawn, flower bed, field and wood floor paint on any kind. */
const BASE_MESHES: MeshConfig[] = [
  LAWN_MESH,
  { id: 'flowers', color: '#ffffff', mapTextureUrl: FLOWERS, roughness: 0.9 },
  { id: 'field', color: '#ffffff', mapTextureUrl: FIELD, roughness: 1 },
  { id: 'floor', color: '#ffffff', mapTextureUrl: PLANKS, roughness: 0.7 },
];
/** What lies under a beach's sand cover, so the water's edge washes onto sand rather than lawn. */
export const SAND_MESH: MeshConfig = { id: 'sand', color: '#cdb37c', roughness: 1 };
/** An island's meshes: the base floors, then its own (one of its own replaces a base floor of the same id). */
export const withBaseMeshes = (...own: MeshConfig[]): MeshConfig[] => [...BASE_MESHES.filter((base) => !own.some((mesh) => mesh.id === base.id)), ...own];

/** The colour of earth cliffs' sides (see `groupTiles`). */
export const EARTH_MESH: MeshConfig = { id: 'earth', color: '#a07a52', roughness: 1 };
/** The groups of an island whose woods stand on raised earth. */
export const WOODED_GROUPS = { ground: { name: 'ground', floorMeshId: 'lawn' }, woods: { name: '숲 언덕', floorMeshId: 'earth' } };

/** Blades per m² of a tall grass patch. */
export const TALL_GRASS = 52;
/** The sides of raised ground: earth. */
export const DIRT = { terrainColor: '#a57b52', terrainAccentColor: '#7f5b3a' };
/** Roads: packed earth over the lawn, fading into it. */
export const ROAD = { terrainColor: '#e8d2a2', terrainAccentColor: '#cfab74' };

/** One floor cell as a template draws it: its height (`y`, 0 by default) and how the engine covers it. */
export type TileSpec = Omit<TileConfig, 'id' | 'tileGroupId' | 'position'> & { y?: number; group?: string };

/** A tile per map character, row by row (north first); `paint` says what each one is, and which group it is in. */
export function tilesFromMap(map: readonly string[], paint: (kind: string, x: number, z: number) => TileSpec): TileConfig[] {
  const tiles: TileConfig[] = [];
  for (let z = 0; z < map.length; z++) {
    for (let x = 0; x < (map[z]?.length ?? 0); x++) {
      const { y = 0, group = 'ground', ...spec } = paint(map[z]![x]!, x, z);
      tiles.push({ id: `tile-${x}-${z}`, tileGroupId: group, size: 1, position: { x: at(x), y, z: at(z) }, ...spec });
    }
  }
  return tiles;
}

/**
 * The tiles in their groups. A group's floor mesh colours the sides of its raised tiles (the engine shades them toward
 * earth), so cliffs, dunes and houses each go in a group whose floor is the colour their sides should be.
 */
export function groupTiles(tiles: readonly TileConfig[], groups: Record<string, { name: string; floorMeshId: string }>): TileGroupConfig[] {
  return Object.entries(groups)
    .map(([id, { name, floorMeshId }]) => ({ id, name, floorMeshId, tiles: tiles.filter((tile) => tile.tileGroupId === id) }))
    .filter((group) => group.tiles.length > 0);
}

/** What a map holds at (x, z); off the map is beach. */
export const cellOf = (map: readonly string[]) => (x: number, z: number) => map[z]?.[x] ?? 's';

/** A model from the engine's catalog, at its catalog size times `scale`. */
export const model = (id: string, catalogId: string, x: number, z: number, rotation = 0, scale = 1, y = 0): PlacedObject => {
  const item = getDefaultBuildingObject(catalogId)!;
  return {
    id,
    type: 'model',
    position: { x, y, z },
    rotation,
    config: { modelId: item.id, modelLabel: item.label, modelScale: item.defaultScale * scale, modelFallbackKind: item.fallbackKind, ...(item.modelUrl ? { modelUrl: item.modelUrl } : {}) },
  };
};

/**
 * The island props in every decorating drawer (`frontend/public/gltf/decor`, catalog `prop-<id>`), by the names the
 * catalog gives them (server/migrations/20261005090000_island_props.sql). Their models are made in meters.
 */
export const DECOR_LABELS = {
  'door-basic': '현관문', 'window-basic': '창문', 'fence-basic': '울타리', 'lamp-basic': '정원 조명', 'chair-basic': '의자',
  'table-basic': '식탁', 'bed-basic': '침대', 'storage-basic': '수납장', 'mailbox-basic': '우편함', 'crafting-basic': '제작대',
  'shop-stall-basic': '가판대', 'flower-pot': '화분', 'deco-fountain': '분수', 'deco-bird-bath': '새 물통',
  'deco-stone-lantern': '석등', 'deco-statue-fox': '여우 석상', 'deco-statue-bear': '곰 목각상', 'deco-sundial': '해시계',
  'deco-flower-arch': '꽃 아치', 'deco-bench': '정원 벤치', 'deco-well': '우물', 'deco-signpost': '이정표',
  'deco-picnic-table': '피크닉 테이블', 'deco-parasol-table': '파라솔 테이블', 'deco-notice-board': '게시판',
  'farm-scarecrow': '허수아비', 'farm-hay-bale': '건초 더미', 'farm-veg-crate': '채소 상자', 'farm-wheelbarrow': '손수레',
  'farm-watering-can': '물뿌리개', 'farm-beehive': '벌통', 'farm-barrel': '오크통', 'crop-pumpkin': '호박밭',
  'crop-cabbage': '양배추 이랑', 'crop-corn': '옥수수', 'crop-wheat': '밀밭', 'crop-carrot': '당근 이랑',
  'nature-flower-red': '빨간 꽃', 'nature-flower-yellow': '노란 꽃', 'nature-flower-purple': '보라 꽃', 'nature-lily': '연꽃',
  'flower-tulip-bed': '튤립 화단', 'flower-sunflower': '해바라기', 'flower-rose-bush': '장미 덤불', 'flower-hydrangea': '수국',
  'flower-lavender': '라벤더 화단', 'flower-daisy': '들꽃 무더기', 'nature-rock-round': '둥근 바위', 'nature-rock-wide': '넓은 바위',
  'nature-rock-tall': '높은 바위', 'nature-rock-small': '작은 돌', 'nature-rock-flat': '납작 돌', 'nature-rock-moss': '이끼 바위',
  'nature-rock-large': '큰 바위', 'rock-pile-small': '작은 돌무더기', 'rock-pile-large': '큰 돌무더기', 'rock-cairn': '돌탑',
  'rock-boulder-moss': '이끼 덮인 큰 바위', 'rock-ledge': '층진 바위', 'nature-tree-round': '둥근 나무', 'nature-tree-oak': '열매 나무',
  'nature-tree-pine': '소나무', 'nature-tree-fat': '통통한 나무', 'nature-tree-thin': '가는 나무', 'nature-fern': '고사리',
  'nature-bush': '덤불', 'nature-stump': '그루터기', 'nature-fallen-log': '쓰러진 통나무', 'nature-mushroom-cluster': '버섯',
} as const;
export type DecorId = keyof typeof DECOR_LABELS;

/** An island prop, `scale` times its made size. */
export const decor = (id: string, prop: DecorId, x: number, z: number, rotation = 0, scale = 1, y = 0): PlacedObject => ({
  id,
  type: 'model',
  position: { x, y, z },
  rotation,
  config: { modelId: `prop-${prop}`, modelLabel: DECOR_LABELS[prop], modelScale: scale, modelUrl: `/gltf/decor/${prop}.glb` },
});

type TreeKind = BuildingTreeKind;
/** One of the engine's drawn trees, `size` meters across its crown. */
export const tree = (id: string, treeKind: TreeKind, x: number, z: number, size = 4, y = 0): PlacedObject =>
  ({ id, type: treeKind === 'sakura' ? 'sakura' : 'tree', position: { x, y, z }, config: { treeKind, size } });

export const fire = (id: string, x: number, z: number, fireIntensity = 1.2, y = 0): PlacedObject =>
  ({ id, type: 'fire', position: { x, y, z }, config: { fireIntensity } });

/** A flag's cloth: `color` with a white disc on it (the engine draws a flag without a picture plain red). */
const flagCloth = (color: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" viewBox="0 0 160 100"><rect width="160" height="100" fill="${color}"/><circle cx="80" cy="50" r="22" fill="#ffffff" opacity="0.9"/></svg>`,
  )}`;

export const flag = (
  id: string,
  x: number,
  z: number,
  options: { style?: FlagStyle; color: string; picture?: string; width?: number; height?: number; rotation?: number; y?: number },
): PlacedObject => ({
  id,
  type: 'flag',
  position: { x, y: options.y ?? 0, z },
  ...(options.rotation ? { rotation: options.rotation } : {}),
  config: {
    flagWidth: options.width ?? 1.6,
    flagHeight: options.height ?? 1,
    flagStyle: options.style ?? 'flag',
    flagTexture: options.picture ?? flagCloth(options.color),
  },
});

/** A sign: a short name, or a picture (an SVG data URL), `elevation` meters up. */
export const sign = (
  id: string,
  x: number,
  z: number,
  options: { text?: string; image?: string; color: string; width: number; height: number; elevation: number; rotation?: number; y?: number },
): PlacedObject => ({
  id,
  type: 'billboard',
  position: { x, y: options.y ?? 0, z },
  ...(options.rotation ? { rotation: options.rotation } : {}),
  config: {
    ...(options.text ? { billboardText: options.text } : {}),
    ...(options.image ? { billboardImageUrl: options.image } : {}),
    billboardColor: options.color,
    billboardWidth: options.width,
    billboardHeight: options.height,
    billboardElevation: options.elevation,
  },
});

export type Side = 'north' | 'south' | 'east' | 'west';
/** A wall on `side` of cell (x, z), placed the way the engine's wall tool places it. */
export function wall(id: string, x: number, z: number, side: Side, wallGroupId: string, kind?: BuildingWallKind, level = 0): WallConfig {
  const { position, rotationY } = edgeToWallTransform({ x: at(x) / CELL, z: at(z) / CELL, level, side });
  return { id, wallGroupId, position, rotation: { x: 0, y: rotationY, z: 0 }, ...(kind ? { wallKind: kind } : {}) };
}

/**
 * A low-poly tree on every `T` cell of `map`, from `kinds`, each turned and sized its own way and nudged off the grid
 * so the edge reads as woods, not a row. Same-model trees draw as one batch.
 */
export function woods(map: readonly string[], kinds: readonly string[], height = 1, skip: (x: number, z: number) => boolean = () => false): PlacedObject[] {
  const trees: PlacedObject[] = [];
  const cell = cellOf(map);
  for (let z = 0; z < map.length; z++) {
    for (let x = 0; x < SIDE; x++) {
      if (cell(x, z) !== 'T' || skip(x, z)) continue;
      const kind = kinds[Math.floor(noise(x, z, 5) * kinds.length)]!;
      const jitter = (salt: number) => (noise(x, z, salt) - 0.5) * 2.4;
      trees.push(model(`tree-${x}-${z}`, kind, at(x) + jitter(1), at(z) + jitter(2), noise(x, z, 3) * Math.PI * 2, 0.95 + noise(x, z, 4) * 0.35, height));
    }
  }
  return trees;
}

/** Undergrowth where the woods meet open ground: `kinds` on the `open` side of `T` cells, about every other cell. */
export function woodsEdge(map: readonly string[], kinds: readonly string[], skip: (x: number, z: number) => boolean = () => false): PlacedObject[] {
  const props: PlacedObject[] = [];
  const cell = cellOf(map);
  for (let z = 1; z < map.length - 1; z++) {
    for (let x = 1; x < SIDE - 1; x++) {
      if (cell(x, z) !== '.' || skip(x, z) || ![cell(x - 1, z), cell(x + 1, z), cell(x, z - 1)].includes('T')) continue;
      if (noise(x, z, 9) < 0.45) continue;
      const kind = kinds[Math.floor(noise(x, z, 10) * kinds.length)]!;
      props.push(model(`edge-${x}-${z}`, kind, at(x) + (noise(x, z, 11) - 0.5) * 3, at(z) + (noise(x, z, 12) - 0.5) * 3, noise(x, z, 13) * Math.PI * 2));
    }
  }
  return props;
}

/**
 * Undergrowth on the open side of the woods, as `woodsEdge` but kept off the raised ground: each piece leans away from
 * the woods beside it, a little either way.
 */
export function forestFloor(map: readonly string[], kinds: readonly string[], skip: (x: number, z: number) => boolean = () => false): PlacedObject[] {
  const props: PlacedObject[] = [];
  const cell = cellOf(map);
  for (let z = 1; z < map.length - 1; z++) {
    for (let x = 1; x < SIDE - 1; x++) {
      const west = cell(x - 1, z) === 'T';
      const east = cell(x + 1, z) === 'T';
      const north = cell(x, z - 1) === 'T';
      if (cell(x, z) !== '.' || skip(x, z) || !(west || east || north) || noise(x, z, 9) < 0.45) continue;
      const kind = kinds[Math.floor(noise(x, z, 10) * kinds.length)]!;
      const dx = (west ? 0.6 : 0) - (east ? 0.6 : 0) + (noise(x, z, 11) - 0.5) * 1.2;
      const dz = (north ? 0.6 : 0) + (noise(x, z, 12) - 0.5) * 1.2;
      props.push(model(`floor-${x}-${z}`, kind, at(x) + dx, at(z) + dz, noise(x, z, 13) * Math.PI * 2));
    }
  }
  return props;
}

/** A trigger box spanning whole cells, from cell (x, z) `width` cells east and `depth` cells south. */
export const area = (id: string, x: number, z: number, width: number, depth: number): GameplayAreaConfig =>
  ({ id, center: [at(x) + ((width - 1) * CELL) / 2, 1, at(z) + ((depth - 1) * CELL) / 2], size: [width * CELL, 4, depth * CELL] });

/** A note when the player walks into `areaId`. */
export const arrive = (areaId: string, text: string): GameplayEventBlueprint => ({
  id: `arrive-${areaId}`, name: `${areaId} 도착`, trigger: { type: 'enterArea', areaId }, actions: [{ type: 'toast', kind: 'info', text }],
});

/** Where a slot's prop stands: [slot, object id, x, z, turn]. */
export type SlotPlacement<Slot extends string> = readonly [slot: Slot, id: string, x: number, z: number, rotation?: number];

/**
 * Props that stand in for ones not made yet. `props` names each slot's stand-in (and its size); `placements` where
 * the slot's objects go. A prop made for a slot replaces all its stand-ins by changing that slot's line in `props`.
 */
export function standIns<Slot extends string>(props: Record<Slot, { prop: DecorId; scale?: number }>, placements: readonly SlotPlacement<Slot>[]) {
  return {
    objects: (): PlacedObject[] =>
      placements.map(([slot, id, x, z, rotation = 0]) => decor(id, props[slot].prop, x, z, rotation, props[slot].scale ?? 1)),
    slots: (Object.keys(props) as Slot[]).map(
      (slot): IslandSlot => ({ id: slot, prop: props[slot].prop, objects: placements.filter((placement) => placement[0] === slot).map((placement) => placement[1]) }),
    ),
  };
}
