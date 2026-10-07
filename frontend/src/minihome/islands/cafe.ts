import type { BuildingSerializedState, MeshConfig, PlacedObject, TileConfig, WallConfig } from 'gaesup-world/building';

import {
  area,
  arrive,
  at,
  decor,
  DIRT,
  EARTH_MESH,
  forestFloor,
  groupTiles,
  model,
  ROAD,
  SAND_MESH,
  scatter,
  sign,
  standIns,
  svg,
  tilesFromMap,
  tree,
  wall,
  woods,
  withBaseMeshes,
  WOODED_GROUPS,
} from './kit';
import { GOLDEN, ROOM_LIGHT } from './sky';
import type { IslandTemplate } from './types';

/**
 * A café with a glass front on a terrace, a garden table beside it, herb and lavender beds, a pond and the beach below.
 * T woods · . lawn · F café floor · t terrace · = path · h herbs · l lavender · ~ pond · b bakery stall · s beach
 */
const MAP = [
  'TTTTTTTTTTTTTT',
  'TT..FFFFFF.TTT',
  'T...FFFFFF...T',
  'T...FFFFFF...T',
  'T...tttttt...T',
  'T...tttttt...T',
  'T.......=....T',
  'T.hh....=.ll.T',
  'T.hh....=.ll.T',
  'T.......=.~~.T',
  'T.bb....=.~~.T',
  '........=.....',
  'ssssssss=sssss',
  'ssssssssssssss',
];
/** The café's floor cells, and the cell of its front left open for a door. */
const CAFE = { x0: 4, x1: 9, z0: 1, z1: 3, door: 8 };

const HERRINGBONE = svg(
  Array.from({ length: 8 }, (_, row) =>
    Array.from({ length: 4 }, (_, col) => {
      const [x, y] = [col * 32, row * 16];
      const fill = (row + col) % 3 ? '#c48b55' : '#b97f4b';
      return `<path d="M${x} ${y + 16}l16 -16h16l-16 16z" fill="${fill}"/><path d="M${x + 16} ${y}l16 16h-16l-16 -16z" fill="${(row + col) % 2 ? '#cf9862' : '#c38a55'}"/>`;
    }).join(''),
  ).join(''),
  '#a8743f',
);
const TERRACE = svg(
  [0, 32, 64, 96].map((v) => `<path d="M0 ${v}h128M${v} 0v128" stroke="#c07a52" stroke-width="2"/>`).join('') +
    scatter(8, 31, (x, y) => `<circle cx="${x}" cy="${y}" r="2" fill="#d99a72"/>`),
  '#de9f78',
);
/** The menu over the counter: a chalkboard with a cup and lines drawn on it. */
const MENU = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128" viewBox="0 0 256 128">' +
    '<rect width="256" height="128" rx="10" fill="#8a5a36"/><rect x="9" y="9" width="238" height="110" rx="5" fill="#2f3d36"/>' +
    '<g fill="none" stroke="#f4efe2" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M34 54h50v26a20 20 0 0 1-20 20h-10a20 20 0 0 1-20-20z"/><path d="M84 62h7a9 9 0 0 1 0 18h-7"/>' +
    '<path d="M46 44c-4-6 4-10 0-16M60 44c-4-6 4-10 0-16M72 44c-4-6 4-10 0-16"/><path d="M28 106h70"/>' +
    '<path d="M124 36h64M124 58h88M124 80h52M124 102h76"/></g>' +
    '<g fill="#f2c94c"><circle cx="220" cy="36" r="5"/><circle cx="196" cy="80" r="5"/><circle cx="220" cy="102" r="5"/></g></svg>',
)}`;

const MESHES: MeshConfig[] = withBaseMeshes(
  EARTH_MESH,
  { id: 'cafe-floor', color: '#ffffff', mapTextureUrl: HERRINGBONE, roughness: 0.6 },
  { id: 'terrace', color: '#ffffff', mapTextureUrl: TERRACE, roughness: 0.85 },
  { id: 'cafe-inside', color: '#f2e6d3', roughness: 0.85 },
  { id: 'cafe-brick', color: '#9a5a40', roughness: 0.85 },
  SAND_MESH,
);

function tiles(): TileConfig[] {
  return tilesFromMap(MAP, (kind) => {
    if (kind === 'T') return { y: 1, group: 'woods', materialId: 'lawn', objectConfig: DIRT };
    if (kind === 'F') return { materialId: 'cafe-floor' };
    if (kind === 't') return { materialId: 'terrace' };
    if (kind === '=') return { materialId: 'lawn', objectType: 'dirt', objectConfig: ROAD };
    if (kind === 'h') return { materialId: 'field', objectType: 'farm', objectConfig: { farm: { crop: 'herb' } } };
    if (kind === 'l') return { materialId: 'field', objectType: 'farm', objectConfig: { farm: { crop: 'lavender' } } };
    if (kind === '~') return { objectType: 'water' };
    if (kind === 's') return { materialId: 'sand', objectType: 'sand' };
    return { materialId: 'lawn' };
  });
}

/** Brick outside and cream inside; the glass front faces the terrace, with the door left open in it. */
function walls(): WallConfig[] {
  const list: WallConfig[] = [];
  for (let x = CAFE.x0; x <= CAFE.x1; x++) {
    list.push(wall(`cafe-north-${x}`, x, CAFE.z0, 'north', 'cafe', (x - CAFE.x0) % 2 ? 'window' : 'solid'));
    if (x !== CAFE.door) list.push({ ...wall(`cafe-front-${x}`, x, CAFE.z1, 'south', 'cafe', 'glass'), flipSides: true });
  }
  for (let z = CAFE.z0; z <= CAFE.z1; z++) {
    const kind = z === CAFE.z0 + 1 ? 'window' : 'solid';
    list.push(wall(`cafe-west-${z}`, CAFE.x0, z, 'west', 'cafe', kind));
    list.push({ ...wall(`cafe-east-${z}`, CAFE.x1, z, 'east', 'cafe', kind), flipSides: true });
  }
  return list;
}

/** Lawn cells the garden's own trees and flowers take, left without undergrowth. */
const GARDEN_BEDS = new Set(['1,5', '12,6', '12,8', '2,1', '2,2', '3,1']);

/** The café's walls, inside faces. */
const BACK = at(CAFE.z0) - 2 + 0.25;
const FRONT = at(CAFE.z1) + 2 - 0.25;
const WEST = at(CAFE.x0) - 2 + 0.25;
const EAST = at(CAFE.x1) + 2 - 0.25;
/** Where the counter stands along the back wall. */
const COUNTER_X = -5;

/** What the café waits for; each slot's line names the prop standing in for it now. */
const SLOTS = standIns(
  {
    'cafe-counter': { prop: 'table-basic' },
    'cafe-menu-board': { prop: 'deco-notice-board' },
    'cafe-bistro-set': { prop: 'deco-picnic-table' },
    'cafe-bar-stool': { prop: 'chair-basic' },
    'cafe-display-case': { prop: 'storage-basic' },
    'cafe-plant-shelf': { prop: 'flower-pot' },
    'cafe-coffee-sack': { prop: 'farm-barrel', scale: 0.8 },
    'cafe-coffee-cart': { prop: 'shop-stall-basic' },
  },
  [
    ['cafe-counter', 'counter', COUNTER_X, BACK + 2.1, Math.PI / 2],
    ['cafe-bar-stool', 'stool-a', COUNTER_X - 1.2, BACK + 3.6, Math.PI],
    ['cafe-bar-stool', 'stool-b', COUNTER_X, BACK + 3.6, Math.PI],
    ['cafe-bar-stool', 'stool-c', COUNTER_X + 1.2, BACK + 3.6, Math.PI],
    ['cafe-display-case', 'display', COUNTER_X - 4.4, BACK + 0.45],
    ['cafe-coffee-sack', 'beans', COUNTER_X + 2.6, BACK + 0.6],
    ['cafe-bistro-set', 'bistro-a', EAST - 2.4, -20.8],
    ['cafe-bistro-set', 'bistro-b', EAST - 2.4, -16.8],
    ['cafe-bistro-set', 'bistro-c', COUNTER_X + 0.4, -17.4],
    ['cafe-plant-shelf', 'plants-a', WEST + 0.5, FRONT - 0.5],
    ['cafe-plant-shelf', 'plants-b', EAST - 0.5, FRONT - 0.5],
    ['cafe-plant-shelf', 'plants-c', EAST - 0.5, BACK + 0.5],
    ['cafe-menu-board', 'menu-board', at(7) - 0.6, FRONT + 1.6],
    ['cafe-coffee-cart', 'coffee-cart', at(2) + 2, at(10) - 0.4],
  ],
);

/** A table for four: the table, two chairs north of it and two south. */
const tableForFour = (id: string, x: number, z: number): PlacedObject[] => [
  decor(`${id}-table`, 'table-basic', x, z, Math.PI / 2),
  decor(`${id}-chair-nw`, 'chair-basic', x - 0.6, z - 1.3),
  decor(`${id}-chair-ne`, 'chair-basic', x + 0.6, z - 1.3),
  decor(`${id}-chair-sw`, 'chair-basic', x - 0.6, z + 1.3, Math.PI),
  decor(`${id}-chair-se`, 'chair-basic', x + 0.6, z + 1.3, Math.PI),
];

function build(): BuildingSerializedState {
  const objects: PlacedObject[] = [
    // Inside: the counter with the menu over it, shelves, two tables for four and lamps.
    sign('menu', COUNTER_X, BACK + 0.2, { image: MENU, color: '#ffffff', width: 2.4, height: 1.2, elevation: 1.9 }),
    decor('bookcase-west', 'storage-basic', WEST + 1, BACK + 0.45),
    decor('bookcase-east', 'storage-basic', EAST - 2.2, BACK + 0.45),
    ...tableForFour('four-a', WEST + 3.8, -20.3),
    ...tableForFour('four-b', WEST + 3.8, -16.5),
    decor('lamp-in-west', 'lamp-basic', WEST + 0.5, -18.4),
    decor('lamp-in-east', 'lamp-basic', EAST - 0.5, -18.8),
    // Over the door, and the terrace in front.
    sign('cafe-sign', at(CAFE.door), FRONT + 0.6, { text: '카페', color: '#ffd59a', width: 1.8, height: 1.2, elevation: 2.9 }),
    decor('terrace-parasol-a', 'deco-parasol-table', at(4) + 0.4, at(4) + 1.8),
    decor('terrace-parasol-b', 'deco-parasol-table', at(5) + 1.8, at(4) + 1.8),
    decor('terrace-parasol-c', 'deco-parasol-table', at(5), at(5) + 1.4),
    decor('terrace-pot-a', 'flower-pot', at(4) - 1.5, at(5) + 1.6),
    decor('terrace-pot-b', 'flower-pot', at(6) + 1.5, at(5) + 1.6),
    decor('terrace-pot-c', 'flower-pot', at(9) + 1.6, at(4) - 1.3),
    decor('terrace-pot-d', 'flower-pot', at(9) + 1.6, at(5) + 1.6),
    decor('terrace-tulips-a', 'flower-tulip-bed', at(3), at(4) - 0.4),
    decor('terrace-tulips-b', 'flower-tulip-bed', at(11), at(4) - 0.4),
    decor('terrace-lamp-a', 'lamp-basic', at(4) - 1.6, at(4) - 0.4, 0, 2),
    decor('terrace-lamp-b', 'lamp-basic', at(10) - 1, at(5) + 1.4, 0, 2),
    // The garden table beside the café.
    decor('side-picnic', 'deco-picnic-table', at(2) + 1, at(2) - 0.6),
    decor('side-roses', 'flower-rose-bush', at(2) + 0.4, at(3) + 0.6),
    decor('side-lamp', 'lamp-basic', at(3) + 0.8, at(1) - 0.2, 0, 2),
    // The garden walk down to the beach.
    decor('arch', 'deco-flower-arch', at(8), at(6) + 0.6),
    tree('garden-sakura-a', 'sakura', at(1) + 0.4, at(5) + 0.4, 3.4),
    tree('garden-sakura-b', 'sakura', at(12) - 0.4, at(6) + 0.6, 3.4),
    tree('garden-birch-a', 'birch', at(5), at(8) + 0.6, 3.2),
    tree('garden-birch-b', 'birch', at(12), at(10) + 1.4, 3.2),
    decor('rose-a', 'flower-rose-bush', at(4) + 0.6, at(7) - 0.6),
    decor('rose-b', 'flower-rose-bush', at(6) + 0.2, at(10) - 0.2),
    decor('hydrangea-a', 'flower-hydrangea', at(9) + 1.4, at(7) - 0.4),
    decor('hydrangea-b', 'flower-hydrangea', at(12) + 0.6, at(8) + 0.4),
    decor('bird-bath', 'deco-bird-bath', at(6), at(7)),
    decor('pond-bench', 'deco-bench', at(9) + 0.6, at(10) - 0.2, Math.PI / 2),
    model('lily-a', 'nature-lily', at(10) + 0.4, at(9) + 0.6, 0.3, 2),
    model('lily-b', 'nature-lily', at(11) - 0.6, at(10) - 0.4, 1.9, 2),
    model('lily-c', 'nature-lily', at(11) + 0.8, at(9) - 0.8, 4.1, 1.8),
    model('pond-rock-a', 'nature-rock-round', at(12) + 0.4, at(9) + 0.6, 0.8),
    model('pond-rock-b', 'nature-rock-wide', at(10) - 0.6, at(11) + 0.6, 2.4),
    // The bakery stall by the herbs.
    decor('bakery-table', 'deco-picnic-table', at(4), at(10) + 0.6, Math.PI / 2),
    decor('bakery-barrel', 'farm-barrel', at(1) + 0.6, at(10) + 0.4),
    // The beach.
    decor('beach-parasol', 'deco-parasol-table', at(4), at(12) + 1.2),
    decor('beach-log', 'nature-fallen-log', at(11), at(12) + 1, 0.3),
    ...SLOTS.objects(),
    ...forestFloor(MAP, ['nature-fern', 'nature-bush', 'nature-fern', 'nature-mushroom-cluster'], (x, z) => (z <= CAFE.z1 + 1 && x >= CAFE.x0 - 1 && x <= CAFE.x1 + 1) || GARDEN_BEDS.has(`${x},${z}`)),
    ...woods(MAP, ['nature-tree-round', 'nature-tree-fat', 'nature-tree-oak', 'nature-tree-round', 'nature-tree-pine'], 1, (x, z) => z === 0 && x >= CAFE.x0 - 2 && x <= CAFE.x1 + 1),
  ];
  return {
    version: 1,
    meshes: MESHES,
    tileGroups: groupTiles(tiles(), WOODED_GROUPS),
    wallGroups: [{ id: 'cafe', name: '카페', frontMeshId: 'cafe-inside', backMeshId: 'cafe-brick', sideMeshId: 'cafe-brick', walls: walls() }],
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

const inside = area('cafe', CAFE.x0, CAFE.z0, CAFE.x1 - CAFE.x0 + 1, CAFE.z1 - CAFE.z0 + 1);

export const cafe: IslandTemplate = {
  id: 'cafe',
  label: '카페',
  build,
  areas: [inside, area('terrace', CAFE.x0, 4, CAFE.x1 - CAFE.x0 + 1, 2), area('garden', 1, 7, 3, 2), area('beach', 0, 12, 14, 2)],
  rules: [arrive('cafe', '☕ 카페'), arrive('terrace', '🌷 테라스'), arrive('garden', '🌿 허브 정원'), arrive('beach', '🌊 해변')],
  rooms: [{ id: 'cafe', center: [...inside.center], size: [...inside.size], profile: ROOM_LIGHT, lamp: { color: '#ffd09a', intensity: 12, distance: 16, height: 3.4 } }],
  sky: GOLDEN,
  residentSpots: [[4, -16], [4, 16], [-19, -4], [20, 0], [-2, 0], [0, -21], [20, -20], [9, -4], [-9, 12], [-3, -9], [7, 6], [17, -10]],
  picture: '/islands/cafe.webp',
  slots: SLOTS.slots,
};
