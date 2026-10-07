import type { BuildingSerializedState, MeshConfig, PlacedObject, TileConfig, WallConfig } from 'gaesup-world/building';

import { area, arrive, at, cellOf, decor, fire, groupTiles, model, noise, scatter, SIDE, standIns, svg, tilesFromMap, tree, wall, withBaseMeshes } from './kit';
import { ROOM_LAMP, ROOM_LIGHT, SNOW } from './sky';
import type { IslandTemplate } from './types';

/**
 * A winter island: snowy woods round a clearing, a log cabin, frozen ponds and a fire on the cobbled square.
 * T snowy woods · . snow · C cabin floor · * deep snow · i ice · , cobbles · w icy water
 */
const MAP = [
  'TTTTTTTTTTTTTT',
  'T.CCC........T',
  'T.CCC..**....T',
  'T......**.ii.T',
  'T.........ii.T',
  'T.....,,,,...T',
  'T.**..,,,,.**T',
  'T.**......**.T',
  'T.....ii.....T',
  'T.....ii..**.T',
  'T..**........T',
  '..............',
  'wwwwwwwwwwwwww',
  'wwwwwwwwwwwwww',
];
const CABIN = { x0: 2, x1: 4, z0: 1, z1: 2 };
/** The sides of the snowy woods' raised ground: snow over frozen earth. */
const DRIFT = { terrainColor: '#f4f8fc', terrainAccentColor: '#cfdbe8' };

const SNOW_GROUND = svg(scatter(18, 51, (x, y) => `<ellipse cx="${x}" cy="${y}" rx="7" ry="3" fill="#e6eef6"/>`), '#f6f9fc');
const ICE = svg(
  `<path d="M10 30l30 14 18-10 26 22 34-6M20 96l26-12 22 16 30-20" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.8"/>` +
    scatter(10, 52, (x, y) => `<circle cx="${x}" cy="${y}" r="3" fill="#e8f4fc"/>`),
  '#cfe6f5',
);
const COBBLES = svg(
  scatter(46, 53, (x, y, i) => `<ellipse cx="${x}" cy="${y}" rx="${6 + (i % 3)}" ry="${5 + (i % 2)}" fill="${['#9a958c', '#8c877e', '#a9a49b'][i % 3]}"/>`),
  '#77736b',
);

const MESHES: MeshConfig[] = withBaseMeshes(
  { id: 'snow', color: '#ffffff', mapTextureUrl: SNOW_GROUND, roughness: 0.95 },
  { id: 'ice', color: '#ffffff', mapTextureUrl: ICE, roughness: 0.25, metalness: 0.05 },
  { id: 'cobbles', color: '#ffffff', mapTextureUrl: COBBLES, roughness: 0.85 },
  { id: 'cabin-inside', color: '#d8b48a', roughness: 0.8 },
  { id: 'cabin-outside', color: '#7c4f30', roughness: 0.8 },
  { id: 'drift-side', color: '#f4f8fc', roughness: 0.95 },
);

function tiles(): TileConfig[] {
  return tilesFromMap(MAP, (kind) => {
    if (kind === 'T') return { y: 1, group: 'drifts', materialId: 'snow', objectConfig: DRIFT };
    if (kind === 'C') return { materialId: 'floor' };
    if (kind === '*') return { materialId: 'snow', objectType: 'snowfield' };
    if (kind === 'i') return { materialId: 'ice' };
    if (kind === ',') return { materialId: 'cobbles' };
    if (kind === 'w') return { objectType: 'water' };
    return { materialId: 'snow' };
  });
}

function walls(): WallConfig[] {
  const list: WallConfig[] = [];
  for (let x = CABIN.x0; x <= CABIN.x1; x++) list.push(wall(`cabin-north-${x}`, x, CABIN.z0, 'north', 'cabin', x === CABIN.x0 + 1 ? 'window' : 'solid'));
  for (let z = CABIN.z0; z <= CABIN.z1; z++) {
    list.push(wall(`cabin-west-${z}`, CABIN.x0, z, 'west', 'cabin', z === CABIN.z1 ? 'window' : 'solid'));
    list.push({ ...wall(`cabin-east-${z}`, CABIN.x1, z, 'east', 'cabin', z === CABIN.z1 ? 'window' : 'solid'), flipSides: true });
  }
  return list;
}

/** Snow-laden pines and cypresses, with a bare tree here and there, on every woods cell. */
function snowyWoods(): PlacedObject[] {
  const cell = cellOf(MAP);
  const kinds = ['pine', 'pine', 'cypress', 'pine', 'dead'] as const;
  const trees: PlacedObject[] = [];
  for (let z = 0; z < MAP.length; z++) {
    for (let x = 0; x < SIDE; x++) {
      if (cell(x, z) !== 'T' || (z === 0 && x >= CABIN.x0 - 1 && x <= CABIN.x1 + 1)) continue;
      const kind = kinds[Math.floor(noise(x, z, 5) * kinds.length)]!;
      const jitter = (salt: number) => (noise(x, z, salt) - 0.5) * 1.6;
      trees.push(tree(`tree-${x}-${z}`, kind, at(x) + jitter(1), at(z) + jitter(2), 3.4 + noise(x, z, 4) * 1.2, 1));
    }
  }
  return trees;
}

/** What the winter island waits for; each slot's line names the prop standing in for it now. */
const SLOTS = standIns(
  {
    'winter-snowman': { prop: 'rock-cairn', scale: 1.6 },
    'winter-sled': { prop: 'farm-wheelbarrow' },
    'winter-snowy-pine': { prop: 'nature-tree-pine' },
  },
  [
    ['winter-snowman', 'snowman-a', at(9) + 1, at(3) - 1],
    ['winter-snowman', 'snowman-b', at(5) - 0.6, at(8) + 0.6],
    ['winter-snowman', 'snowman-c', at(12) - 0.6, at(11)],
    ['winter-sled', 'sled', at(5) + 1.2, at(3) + 0.4, 0.6],
    ['winter-snowy-pine', 'snowy-pine-a', at(2), at(10) - 0.4, 0.4],
    ['winter-snowy-pine', 'snowy-pine-b', at(9) + 0.4, at(11), 2.1],
    ['winter-snowy-pine', 'snowy-pine-c', at(12) + 0.4, at(4) - 1, 4.4],
  ],
);

const BACK = at(CABIN.z0) - 2 + 0.25;
const WEST = at(CABIN.x0) - 2 + 0.25;
const EAST = at(CABIN.x1) + 2 - 0.25;

function build(): BuildingSerializedState {
  const [fx, fz] = [at(7), at(6)];
  const objects: PlacedObject[] = [
    // The log cabin.
    decor('cabin-bed', 'bed-basic', WEST + 1.1, BACK + 2.1),
    decor('cabin-shelf', 'storage-basic', WEST + 4.4, BACK + 0.45),
    decor('cabin-lamp', 'lamp-basic', WEST + 6.2, BACK + 0.5),
    decor('cabin-table', 'table-basic', EAST - 3.2, BACK + 3.2, Math.PI / 2),
    decor('cabin-chair-n', 'chair-basic', EAST - 3.2, BACK + 1.8),
    decor('cabin-chair-s', 'chair-basic', EAST - 3.2, BACK + 4.6, Math.PI),
    decor('cabin-bench', 'crafting-basic', EAST - 0.6, BACK + 6, -Math.PI / 2),
    // The square: the fire, logs to sit on, lanterns at its corners.
    fire('fire', fx, fz, 1.4),
    decor('fire-log-s', 'nature-fallen-log', fx, fz + 2.4, 0),
    decor('fire-log-w', 'nature-fallen-log', fx - 2.5, fz, Math.PI / 2),
    decor('square-bench', 'deco-bench', fx + 2.6, fz + 0.4, -Math.PI / 2),
    decor('lantern-nw', 'deco-stone-lantern', at(6) - 1.4, at(5) - 1.4),
    decor('lantern-ne', 'deco-stone-lantern', at(9) + 1.4, at(5) - 1.4),
    decor('lantern-sw', 'deco-stone-lantern', at(6) - 1.4, at(6) + 1.4),
    decor('lantern-se', 'deco-stone-lantern', at(9) + 1.4, at(6) + 1.4),
    decor('signpost', 'deco-signpost', at(5), at(4)),
    // Rocks in the snow; a bench at the pond.
    model('rock-a', 'nature-rock-round', at(1) + 0.6, at(4), 0.8),
    model('rock-b', 'nature-rock-wide', at(12) + 0.4, at(5) - 0.4, 2.4),
    model('rock-c', 'nature-rock-moss', at(4) + 1, at(9), 1.3),
    model('rock-d', 'nature-rock-large', at(9) + 0.6, at(10), 0.6),
    model('rock-e', 'nature-rock-small', at(1), at(9), 2.7),
    model('rock-f', 'nature-rock-round', at(13) - 0.4, at(11) + 0.4, 4.1),
    decor('pond-bench', 'deco-bench', at(8) + 0.6, at(8) + 0.6, -Math.PI / 2),
    // Trees in the clearing: evergreens, and a bare one.
    tree('clearing-pine-a', 'pine', at(5) + 0.6, at(2), 3.8),
    tree('clearing-pine-b', 'pine', at(11) + 1, at(1) + 0.6, 4),
    tree('clearing-cypress-a', 'cypress', at(1), at(6) - 0.6, 3),
    tree('clearing-cypress-b', 'cypress', at(4), at(7) + 1, 3),
    tree('clearing-dead', 'dead', at(7) - 0.4, at(10) + 0.6, 3.2),
    tree('clearing-pine-c', 'pine', at(12) + 0.4, at(8) - 0.4, 3.6),
    tree('south-pine-a', 'pine', at(1) + 0.6, at(11) + 0.4, 3.6),
    tree('south-pine-b', 'pine', at(4) - 0.4, at(11) + 0.6, 3.2),
    tree('south-cypress', 'cypress', at(6) + 0.4, at(11) + 0.8, 3),
    tree('south-pine-c', 'pine', at(11) - 0.6, at(11) + 0.6, 3.4),
    tree('east-pine', 'pine', at(10) + 0.6, at(7) + 0.4, 3.6),
    tree('north-pine', 'pine', at(2) + 1, at(4) + 0.6, 3.4),
    tree('pond-cypress', 'cypress', at(9) + 1.2, at(4) + 0.8, 3),
    tree('west-pine', 'pine', at(3), at(9) - 0.6, 3.4),
    model('hedge-a', 'nature-bush', at(5) + 1.4, at(10) - 0.4, 0.6),
    model('hedge-b', 'nature-bush', at(12) - 0.2, at(5) + 1.4, 2.1),
    model('hedge-c', 'nature-bush', at(1) + 0.4, at(2) + 0.8, 4.2),
    decor('lantern-path-a', 'deco-stone-lantern', at(3), at(3) + 1.2),
    decor('lantern-path-b', 'deco-stone-lantern', at(11) - 1, at(10) + 1),
    model('ice-rock', 'nature-rock-small', at(6) - 1.6, at(9) + 1.4, 1.9),
    ...SLOTS.objects(),
    ...snowyWoods(),
  ];
  return {
    version: 1,
    meshes: MESHES,
    tileGroups: groupTiles(tiles(), { ground: { name: 'ground', floorMeshId: 'snow' }, drifts: { name: '눈 언덕', floorMeshId: 'drift-side' } }),
    wallGroups: [{ id: 'cabin', name: '통나무집', frontMeshId: 'cabin-inside', backMeshId: 'cabin-outside', sideMeshId: 'cabin-outside', walls: walls() }],
    blocks: [],
    objects,
    showSnow: false,
    showFog: false,
    fogColor: '#e8f0f8',
    weatherEffect: 'none',
    climate: 'off',
    worldSurface: 'water',
  };
}

const cabin = area('cabin', CABIN.x0, CABIN.z0, CABIN.x1 - CABIN.x0 + 1, CABIN.z1 - CABIN.z0 + 1);

export const winter: IslandTemplate = {
  id: 'winter',
  label: '겨울',
  build,
  areas: [cabin, area('ice', 10, 3, 2, 2), area('fire', 6, 6, 4, 1)],
  rules: [arrive('cabin', '🏠 통나무집'), arrive('ice', '⛸️ 얼음 연못'), arrive('fire', '🔥 모닥불')],
  rooms: [{ id: 'cabin', center: [...cabin.center], size: [...cabin.size], profile: ROOM_LIGHT, lamp: ROOM_LAMP }],
  sky: SNOW,
  residentSpots: [[4, -12], [4, 16], [-20, -8], [20, 1], [20, -24], [-6, 2], [-8, -24], [7, 1], [17, -11], [-8, -10], [7, -24], [18, 14]],
  picture: '/islands/winter.webp',
  slots: SLOTS.slots,
};
