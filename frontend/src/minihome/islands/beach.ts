import type { BuildingSerializedState, MeshConfig, PlacedObject, TileConfig } from 'gaesup-world/building';

import { area, arrive, at, decor, fire, flag, groupTiles, model, PLANKS, SAND_MESH, standIns, TALL_GRASS, tilesFromMap, tree, withBaseMeshes } from './kit';
import { BEACH } from './sky';
import type { IslandTemplate } from './types';

/**
 * A beach: grassy dunes in the north, a long sandy shore with a lagoon, and a boardwalk out over the shallows.
 * r dune · R high dune · . grass · " dune grass · s sand · ~ water · W boardwalk
 */
const MAP = [
  'rRRrrrrrrrrRRr',
  'r..rr.....rr.r',
  '..""..""..""..',
  'ssssssssssssss',
  'ssssssssssssss',
  'ssssssssssssss',
  'sss~~~~sssssss',
  'ss~~~~~~ssssss',
  'sss~~~~ss""sss',
  'ssssssssssssss',
  'sssssssssWWsss',
  'sssssssssWWsss',
  '~~~~~~~~~WW~~~',
  '~~~~~~~~~WW~~~',
];
/** The dunes' sides: sand. */
const DUNE = { terrainColor: '#d8bf8a', terrainAccentColor: '#b89d68' };

const MESHES: MeshConfig[] = withBaseMeshes(
  { id: 'boardwalk', color: '#ffffff', mapTextureUrl: PLANKS, roughness: 0.75 },
  SAND_MESH,
  { id: 'dune-side', color: '#e2c992', roughness: 1 },
);

function tiles(): TileConfig[] {
  return tilesFromMap(MAP, (kind) => {
    if (kind === 'r') return { y: 1, group: 'dunes', materialId: 'sand', objectType: 'sand', objectConfig: DUNE };
    if (kind === 'R') return { y: 2, group: 'dunes', materialId: 'sand', objectType: 'sand', objectConfig: DUNE };
    if (kind === '"') return { materialId: 'lawn', objectType: 'grass', objectConfig: { grassDensity: TALL_GRASS } };
    if (kind === 's') return { materialId: 'sand', objectType: 'sand' };
    if (kind === '~') return { materialId: 'sand', objectType: 'water' };
    if (kind === 'W') return { materialId: 'boardwalk' };
    return { materialId: 'lawn' };
  });
}

/** What the beach waits for; each slot's line names the prop standing in for it now. */
const SLOTS = standIns(
  {
    'beach-parasol': { prop: 'deco-parasol-table', scale: 1.4 },
    'beach-lounger': { prop: 'deco-bench' },
    'beach-palm': { prop: 'nature-tree-round', scale: 0.9 },
    'beach-sandcastle': { prop: 'rock-pile-small' },
    'beach-surfboard': { prop: 'deco-signpost' },
    'beach-lighthouse': { prop: 'deco-stone-lantern' },
  },
  [
    ['beach-parasol', 'parasol-a', at(1), at(4)],
    ['beach-parasol', 'parasol-b', at(3) + 0.6, at(3) + 1.2],
    ['beach-parasol', 'parasol-c', at(5), at(4) + 0.6],
    ['beach-parasol', 'parasol-d', at(11), at(4) - 0.4],
    ['beach-parasol', 'parasol-e', at(13), at(3) + 1],
    ['beach-parasol', 'parasol-f', at(11) + 1, at(7)],
    ['beach-lounger', 'lounger-a', at(1) + 2.2, at(4) + 0.6],
    ['beach-lounger', 'lounger-b', at(5) + 2.2, at(4) + 1.2],
    ['beach-lounger', 'lounger-c', at(11) + 2.2, at(4)],
    ['beach-lounger', 'lounger-d', at(12) + 1.4, at(7) + 1.6],
    ['beach-palm', 'palm-a', at(0) + 0.6, at(5) + 0.6, 0.4],
    ['beach-palm', 'palm-b', at(13) - 0.4, at(6), 2.2],
    ['beach-palm', 'palm-c', at(8) + 1.4, at(8) - 0.2, 4.1],
    ['beach-sandcastle', 'castle-a', at(6) + 1.4, at(9) + 0.6],
    ['beach-sandcastle', 'castle-b', at(7) + 0.4, at(10) + 1.2, 1.1],
    ['beach-sandcastle', 'castle-c', at(9) + 1.2, at(6) + 0.4, 2.3],
    ['beach-surfboard', 'board-a', at(12) - 0.6, at(9) + 0.6, -0.4],
    ['beach-lighthouse', 'pier-light', at(10) - 2, at(13) + 1.2],
  ],
);

function build(): BuildingSerializedState {
  const objects: PlacedObject[] = [
    // Rocks and shrubs on the dunes.
    decor('ledge', 'rock-ledge', at(1), at(0) + 0.4, 0.4, 1, 2),
    decor('boulder-a', 'rock-boulder-moss', at(5), at(0) + 0.6, 1.2, 1, 1),
    decor('pile-a', 'rock-pile-large', at(8) + 1, at(0), 2.2, 1, 1),
    decor('boulder-b', 'rock-boulder-moss', at(12), at(0) + 0.6, 4.2, 1, 2),
    model('dune-bush-a', 'nature-bush', at(3), at(0) + 1, 0.3, 1, 1),
    model('dune-bush-b', 'nature-bush', at(10) - 1, at(0) + 1.2, 1.4, 1, 1),
    model('dune-bush-c', 'nature-bush', at(4) - 0.6, at(1), 2.7, 0.9, 1),
    model('dune-rock-a', 'nature-rock-moss', at(11) - 0.4, at(1) - 0.2, 0.9, 1, 1),
    model('dune-rock-b', 'nature-rock-round', at(3) + 0.8, at(1) + 0.6, 3.1, 0.8, 1),
    tree('willow-a', 'willow', at(7), at(0) + 0.6, 3.8, 1),
    tree('willow-b', 'willow', at(2), at(0) + 0.6, 3.6, 2),
    model('grass-bush-a', 'nature-bush', at(0) + 0.4, at(2) + 0.4, 2.2),
    model('grass-bush-b', 'nature-bush', at(13) - 0.4, at(2) + 0.4, 5.2),
    model('grass-bush-c', 'nature-bush', at(8) + 0.6, at(2) - 0.4, 0.8, 0.8),
    flag('flag-a', at(7) + 1.2, at(3) - 0.4, { color: '#ff8a65' }),
    // Picnic tables between the lagoon and the boardwalk.
    decor('picnic-a', 'deco-picnic-table', at(8) - 0.8, at(10) + 1.2, Math.PI / 2),
    decor('picnic-b', 'deco-picnic-table', at(12) + 0.4, at(11), Math.PI / 2),
    // The lagoon's rocks.
    model('lagoon-rock-a', 'nature-rock-round', at(2) + 0.4, at(6) - 0.2, 0.8),
    model('lagoon-rock-b', 'nature-rock-wide', at(8) - 0.4, at(7) + 0.4, 2.4),
    model('lagoon-rock-c', 'nature-rock-large', at(5), at(9) - 0.6, 1.1),
    decor('pile-b', 'rock-pile-small', at(1) + 0.6, at(7) + 1.2),
    decor('pile-c', 'rock-pile-large', at(7) + 0.6, at(6) - 0.8, 0.7),
    // The campfire with driftwood round it.
    fire('campfire', at(3), at(10), 1.2),
    decor('drift-a', 'nature-fallen-log', at(3), at(10) - 2.2, 0),
    decor('drift-b', 'nature-fallen-log', at(3) - 2.3, at(10) + 0.6, 1.4),
    decor('drift-c', 'nature-fallen-log', at(3) + 2.3, at(10) + 0.6, -1.4),
    model('beach-rock-a', 'nature-rock-moss', at(0) + 0.6, at(11) + 0.6, 0.6),
    model('beach-rock-b', 'nature-rock-flat', at(13) - 0.6, at(11) + 0.4, 2),
    // The boardwalk: a stand at its head, barrels, pennants and a bench at the end.
    decor('shop', 'shop-stall-basic', at(10) + 2, at(9) - 0.6),
    decor('deck-barrel-a', 'farm-barrel', at(9) - 1.2, at(11) - 1),
    decor('deck-barrel-b', 'farm-barrel', at(10) + 1.3, at(12) + 1.2),
    flag('deck-flag-a', at(9) - 1.4, at(12), { color: '#5a8acf', width: 1.2, height: 0.7 }),
    flag('deck-flag-b', at(10) + 1.4, at(13) - 0.6, { color: '#ff8a65', width: 1.2, height: 0.7 }),
    decor('deck-bench', 'deco-bench', at(10) + 0.6, at(13) + 1.2),
    ...SLOTS.objects(),
  ];
  return {
    version: 1,
    meshes: MESHES,
    tileGroups: groupTiles(tiles(), { ground: { name: 'ground', floorMeshId: 'lawn' }, dunes: { name: '모래 언덕', floorMeshId: 'dune-side' } }),
    wallGroups: [],
    blocks: [],
    objects,
    showSnow: false,
    showFog: false,
    fogColor: '#dcefff',
    weatherEffect: 'none',
    climate: 'off',
    worldSurface: 'water',
  };
}

export const beach: IslandTemplate = {
  id: 'beach',
  label: '해변',
  build,
  areas: [area('sand', 0, 3, 14, 2), area('lagoon', 2, 6, 6, 3), area('boardwalk', 9, 10, 2, 4), area('campfire', 2, 9, 3, 3)],
  rules: [arrive('sand', '🏖️ 모래사장'), arrive('lagoon', '🌊 석호'), arrive('boardwalk', '⚓ 부두'), arrive('campfire', '🔥 모닥불')],
  rooms: [],
  sky: BEACH,
  residentSpots: [[4, -14], [4, 16], [24, 1], [-20, -8], [20, -24], [-14, -12], [-12, 8], [8, 1], [17, -10], [-7, -8], [17, 12], [9, -24]],
  picture: '/islands/beach.webp',
  slots: SLOTS.slots,
};
