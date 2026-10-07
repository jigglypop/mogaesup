import type { BuildingSerializedState, MeshConfig, PlacedObject, TileConfig, WallConfig } from 'gaesup-world/building';

import {
  area,
  arrive,
  at,
  CELL,
  DIRT,
  FIELD,
  FLOWERS,
  LAWN_MESH,
  model,
  PLANKS,
  ROAD,
  TALL_GRASS,
  tilesFromMap,
  tree,
  wall,
  woods,
  woodsEdge,
} from './kit';
import { DAY, ROOM_LAMP, ROOM_LIGHT } from './sky';
import type { IslandTemplate } from './types';

/**
 * The island every home started as, one character per 4m cell, north at the top.
 * T forest cliff · . lawn · = dirt path · ~ pond · " tall grass · * flower bed · # field · F miniroom floor · s beach
 */
const MAP = [
  'TTTTTTTTTTTTTT',
  'TTTTTTTTTTTTTT',
  'TT.FF...""""TT',
  'TT.FF...""""TT',
  'T.......=....T',
  'T.==========.T',
  'T.=..**.=....T',
  'T~~..**.=.##.T',
  'T~~""...=.##.T',
  'T~~""...==...T',
  'T.......=.""..',
  's.......=.""..',
  'ssssssss=sssss',
  'ssssssssssssss',
];
/** The miniroom's floor cells. */
const ROOM = { x0: 3, x1: 4, z0: 2, z1: 3 };

const MESHES: MeshConfig[] = [
  LAWN_MESH,
  { id: 'flowers', color: '#ffffff', mapTextureUrl: FLOWERS, roughness: 0.9 },
  { id: 'field', color: '#ffffff', mapTextureUrl: FIELD, roughness: 1 },
  { id: 'floor', color: '#ffffff', mapTextureUrl: PLANKS, roughness: 0.7 },
  { id: 'wallpaper', color: '#ffe8ec' },
  { id: 'wall-outside', color: '#fff7ec' },
];

const MATERIAL: Record<string, string> = { '.': 'lawn', T: 'lawn', '*': 'flowers', '#': 'field', F: 'floor' };
const FOREST_TREES = ['nature-tree-pine', 'nature-tree-round', 'nature-tree-pine', 'nature-tree-fat', 'nature-tree-thin'];

function tiles(): TileConfig[] {
  return tilesFromMap(MAP, (kind, _x, z) => {
    const raised = kind === 'T';
    const y = raised ? 1 : 0;
    if (kind === '~') return { y, objectType: 'water' };
    if (kind === 's') return { y, objectType: 'sand' };
    if (kind === '=') return { y, materialId: 'lawn', objectType: 'dirt', objectConfig: ROAD };
    if (kind === '"') return { y, materialId: 'lawn', objectType: 'grass', objectConfig: { grassDensity: TALL_GRASS } };
    // The fenced field: a bed of cabbages north of a bed of carrots.
    if (kind === '#') return { y, materialId: 'field', objectType: 'farm', objectConfig: { farm: { crop: z === 7 ? 'cabbage' : 'carrot' } } };
    return { y, materialId: MATERIAL[kind] ?? 'lawn', ...(raised ? { objectConfig: DIRT } : {}) };
  });
}

/** The fence around the field, one catalog fence per cell edge. */
function fieldFence(): PlacedObject[] {
  const [x0, x1, z0, z1] = [at(10) - CELL / 2, at(11) + CELL / 2, at(7) - CELL / 2, at(8) + CELL / 2];
  const posts: PlacedObject[] = [];
  for (const x of [at(10), at(11)]) {
    posts.push(model(`fence-n-${x}`, 'fence-basic', x, z0));
    posts.push(model(`fence-s-${x}`, 'fence-basic', x, z1));
  }
  for (const z of [at(7), at(8)]) posts.push(model(`fence-e-${z}`, 'fence-basic', x1, z, Math.PI / 2));
  posts.push(model('fence-w', 'fence-basic', x0, at(7), Math.PI / 2));
  return posts;
}

function build(): BuildingSerializedState {
  // The miniroom: two back walls (north and west) like a Cyworld miniroom, open toward the camera. They stand on the
  // floor's edges as the engine's wall tool puts them; islands saved before keep theirs, drawn 2 m into the room.
  const north = at(ROOM.z0) - CELL / 2;
  const west = at(ROOM.x0) - CELL / 2;
  const walls: WallConfig[] = [];
  for (let x = ROOM.x0; x <= ROOM.x1; x++) walls.push(wall(`room-north-${x}`, x, ROOM.z0, 'north', 'room', x === ROOM.x1 ? 'window' : undefined));
  for (let z = ROOM.z0; z <= ROOM.z1; z++) walls.push(wall(`room-west-${z}`, ROOM.x0, z, 'west', 'room', z === ROOM.z1 ? 'window' : undefined));

  const objects: PlacedObject[] = [
    // Miniroom furniture, sized by the catalog for a 1.7m character.
    model('room-bed', 'bed-basic', west + 1.6, north + 1.6),
    model('room-wardrobe', 'storage-basic', west + 4.6, north + 0.5),
    model('room-lamp', 'lamp-basic', west + 3, north + 0.6),
    model('room-table', 'table-basic', west + 5, north + 5),
    model('room-chair-a', 'chair-basic', west + 5, north + 3.9),
    model('room-chair-b', 'chair-basic', west + 5, north + 6.1, Math.PI),
    model('room-crafting', 'crafting-basic', west + 0.8, north + 6, Math.PI / 2),
    {
      id: 'room-frame', type: 'billboard', position: { x: west + 6, y: 0, z: north + 0.4 },
      config: { billboardText: 'HAPPY ISLAND', billboardColor: '#ff8a65', billboardWidth: 1.8, billboardHeight: 0.7, billboardElevation: 2.2 },
    },
    // Village.
    model('mailbox', 'mailbox-basic', at(5) + 1, at(4) - 1),
    model('stall', 'shop-stall-basic', at(10), at(4), Math.PI),
    ...fieldFence(),
    { id: 'campfire', type: 'fire', position: { x: at(4), y: 0, z: at(12) }, config: { fireIntensity: 1.2 } },
    { id: 'plaza-flag', type: 'flag', position: { x: at(9) + 1.2, y: 0, z: at(9) - 1.2 }, config: { flagWidth: 1.6, flagHeight: 1, flagStyle: 'flag', primaryColor: '#ff8a65' } },
    { id: 'notice', type: 'billboard', position: { x: at(7), y: 0, z: at(4) + 1.4 }, config: { billboardText: '모개숲', billboardColor: '#2bb3a3', billboardWidth: 2.2, billboardHeight: 0.8, billboardElevation: 1.3 } },
    model('oak-1', 'nature-tree-oak', at(2), at(4), 0.4),
    model('oak-2', 'nature-tree-round', at(12), at(4), 2.1),
    model('oak-3', 'nature-tree-oak', at(6), at(9) + 1, 4.2),
    model('oak-4', 'nature-tree-fat', at(12), at(9), 1.3, 0.9),
    model('maple-1', 'nature-tree-round', at(1), at(10), 5.5, 0.9),
    model('pond-tree', 'nature-tree-thin', at(3), at(9), 2.7),
    tree('sakura-1', 'sakura', at(7) - 1, at(7) - 1, 3.4),
    tree('sakura-2', 'sakura', at(2), at(7) - 1.5, 3.2),
    // Pond side: boulders, lilies on the water.
    model('pond-rock-a', 'nature-rock-round', at(1) + 1.6, at(8) + 2.2, 0.8),
    model('pond-rock-b', 'nature-rock-wide', at(3) + 1.8, at(7) - 1.4, 2.4),
    model('lily-a', 'nature-lily', at(1) + 0.6, at(7) + 0.4, 0.3, 2),
    model('lily-b', 'nature-lily', at(2) - 0.8, at(8) - 0.6, 1.9, 2.4),
    model('lily-c', 'nature-lily', at(1) - 0.4, at(9) + 0.8, 4.1, 1.8),
    // Along the paths: bushes and flowers.
    model('bush-a', 'nature-bush', at(4) + 1.4, at(5) - 1.6, 0.2),
    model('bush-b', 'nature-bush', at(9) + 1.6, at(6) + 1.2, 1.7, 0.8),
    model('bush-c', 'nature-bush', at(7) - 1.6, at(10) + 1.2, 3.3),
    model('flower-a', 'nature-flower-yellow', at(5) - 1.2, at(6) + 1.6),
    model('flower-b', 'nature-flower-red', at(6) + 1.6, at(7) + 1.5, 1.1),
    model('flower-c', 'nature-flower-purple', at(9) - 1.4, at(8) + 0.4, 2.2),
    model('flower-d', 'nature-flower-yellow', at(11) + 1.5, at(6) - 1.3, 0.7),
    model('rock-path', 'nature-rock-small', at(9) + 1.6, at(10) - 1.2, 0.9),
    model('log-beach', 'nature-fallen-log', at(6) + 1.2, at(11) - 1.2, 0.6),
    ...woodsEdge(MAP, ['nature-fern', 'nature-stump', 'nature-fern', 'nature-mushroom-cluster', 'nature-bush']),
    // No tree on the cliff right behind the miniroom, whose crown would reach in through its back wall.
    ...woods(MAP, FOREST_TREES, 1, (x, z) => x === ROOM.x0 && z === ROOM.z0 - 1),
  ];

  return {
    version: 1,
    meshes: MESHES,
    tileGroups: [{ id: 'ground', name: 'ground', floorMeshId: 'lawn', tiles: tiles() }],
    wallGroups: [{ id: 'room', name: '미니룸', frontMeshId: 'wallpaper', backMeshId: 'wall-outside', sideMeshId: 'wall-outside', walls }],
    blocks: [],
    objects,
    showSnow: false,
    showFog: false,
    fogColor: '#dcefff',
    weatherEffect: 'none',
    worldSurface: 'water',
  };
}

const miniroom = area('miniroom', ROOM.x0, ROOM.z0, ROOM.x1 - ROOM.x0 + 1, ROOM.z1 - ROOM.z0 + 1);

export const forest: IslandTemplate = {
  id: 'forest',
  label: '숲',
  build,
  areas: [miniroom, area('field', 10, 7, 2, 2), area('pond', 1, 7, 2, 3), area('beach', 0, 12, 14, 2)],
  rules: [arrive('miniroom', '🏠 나의 미니룸'), arrive('field', '🌱 텃밭'), arrive('pond', '🐟 연못가'), arrive('beach', '🌊 해변 산책 중')],
  rooms: [{ id: 'miniroom', center: [...miniroom.center], size: [...miniroom.size], profile: ROOM_LIGHT, lamp: ROOM_LAMP }],
  sky: DAY,
  residentSpots: [[4, -14], [4, 16], [-16, 1], [20, 1], [0, 1], [-12, -14], [18, -13], [10, -5], [-9, 12], [-4, -8], [15, 12], [-4, -20]],
  picture: '/islands/forest.webp',
  slots: [],
};
