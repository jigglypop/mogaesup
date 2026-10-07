import type { BuildingSerializedState, MeshConfig, PlacedObject, TileConfig, WallConfig, WallGroupConfig } from 'gaesup-world/building';

import { area, arrive, at, decor, flag, groupTiles, scatter, sign, standIns, svg, tilesFromMap, tree, wall, withBaseMeshes } from './kit';
import { CITY } from './sky';
import type { IslandTemplate } from './types';

/**
 * A shopping street: shops along the north, the road, a plaza with a fountain and a pocket park, market yards, a green
 * strip and a promenade with a boardwalk on the water.
 * H shop · , pavement · = road · # crossing · g grass · P plaza · k market yard · q promenade · d boardwalk
 */
const MAP = [
  'HHHHHHHHHHHHHH',
  'HHHHHHHHHHHHHH',
  ',,,,,,,,,,,,,,',
  '===#======#===',
  '===#======#===',
  ',,,,,,,,,,,,,,',
  ',ggg,PPPPPPP,,',
  ',ggg,PPPPPPP,,',
  ',ggg,PPPPPPP,,',
  ',,,,,,,,,,,,,,',
  'kkkk,,,,,kkkk,',
  'gggggg,,gggggg',
  'qqqqqqqqqqqqqq',
  'dddddddddddddd',
];

const PAVING = svg(
  [0, 32, 64, 96].map((v) => `<path d="M0 ${v}h128M${v} 0v128" stroke="#cbc3b2" stroke-width="2"/>`).join('') +
    scatter(10, 21, (x, y) => `<circle cx="${x}" cy="${y}" r="1.5" fill="#d2cab9"/>`),
  '#e2dccf',
);
const asphalt = (body: string) => svg(scatter(24, 22, (x, y) => `<circle cx="${x}" cy="${y}" r="1.4" fill="#61656b"/>`) + body, '#575b61');
// Road lines sit by a cell's edges, so near the middle of the picture (see `svg`).
const dashes = (y: number, height: number) => [12, 76].map((x) => `<rect x="${x}" y="${y}" width="40" height="${height}" fill="#f2c94c"/>`).join('');
/** The north lane: its kerb line by the north pavement and half the centre line on its south edge. */
const ROAD_NORTH = asphalt(`<rect y="55" width="128" height="4" fill="#eeeeea"/>${dashes(64, 3)}`);
/** The south lane: the other half of the centre line on its north edge and its kerb line by the south pavement. */
const ROAD_SOUTH = asphalt(`${dashes(61, 3)}<rect y="69" width="128" height="4" fill="#eeeeea"/>`);
/** A zebra crossing: bars along the road, stepped over crossing it, short of the cell's sides. */
const CROSSING = asphalt([8, 40, 72, 104].map((y) => `<rect y="${y}" width="54" height="16" fill="#f4f4f0"/><rect x="74" y="${y}" width="54" height="16" fill="#f4f4f0"/>`).join(''));
const BRICKS = svg(
  Array.from({ length: 16 }, (_, i) => {
    const [bx, by] = [(i % 4) * 32, Math.floor(i / 4) * 32];
    const fill = i % 3 ? '#d4876a' : '#cc7c5e';
    return (i + Math.floor(i / 4)) % 2
      ? `<rect x="${bx + 1}" y="${by + 1}" width="14" height="30" fill="${fill}"/><rect x="${bx + 17}" y="${by + 1}" width="14" height="30" fill="${fill}"/>`
      : `<rect x="${bx + 1}" y="${by + 1}" width="30" height="14" fill="${fill}"/><rect x="${bx + 1}" y="${by + 17}" width="30" height="14" fill="${fill}"/>`;
  }).join(''),
  '#b06a4d',
);
const TERRACOTTA = svg([0, 32, 64, 96].map((v) => `<path d="M0 ${v}h128M${v} 0v128" stroke="#b8714a" stroke-width="2"/>`).join(''), '#d48a5f');
const CONCRETE = svg(
  `<path d="M0 0h128M0 64h128M0 0v128M64 0v128" stroke="#a7abac" stroke-width="2"/>` + scatter(16, 23, (x, y) => `<circle cx="${x}" cy="${y}" r="1.2" fill="#b1b5b6"/>`),
  '#c3c7c8',
);
const roof = (base: string, line: string) => svg([8, 24, 40, 56, 72, 88, 104, 120].map((y) => `<path d="M0 ${y}h128" stroke="${line}" stroke-width="3"/>`).join(''), base);

/**
 * Each shop: its sign, the colour of its sides, its front and its roof, and how tall it stands. The heights keep the
 * engine's cliff stones (one now and then at the foot of a raised side, by a hash of the cell and the height) off the
 * shop fronts and the roofs between them.
 */
const SHOPS = [
  { name: '빵집', side: '#f0dcbc', front: '#fff4e2', roof: 'roof-red', height: 5.5, sign: '#ffcf70' },
  { name: '꽃집', side: '#b7e2c6', front: '#e8f8ee', roof: 'roof-slate', height: 4.5, sign: '#ff9fc0' },
  { name: '서점', side: '#b06a50', front: '#c98065', roof: 'roof-slate', height: 5, sign: '#ffe3a8' },
  { name: '편의점', side: '#cdd7e2', front: '#f1f5fa', roof: 'roof-teal', height: 4.25, sign: '#7fe0d0' },
  { name: '옷가게', side: '#efc3cc', front: '#fde8ec', roof: 'roof-red', height: 5.25, sign: '#ffb3c9' },
  { name: '우체국', side: '#e8c46c', front: '#fff1c8', roof: 'roof-slate', height: 4.75, sign: '#ff8a65' },
  { name: '문구점', side: '#9fc4e6', front: '#e5f1fc', roof: 'roof-red', height: 4, sign: '#9ad0ff' },
] as const;

const MESHES: MeshConfig[] = withBaseMeshes(
  { id: 'pavement', color: '#ffffff', mapTextureUrl: PAVING, roughness: 0.9 },
  { id: 'road-north', color: '#ffffff', mapTextureUrl: ROAD_NORTH, roughness: 0.95 },
  { id: 'road-south', color: '#ffffff', mapTextureUrl: ROAD_SOUTH, roughness: 0.95 },
  { id: 'crossing', color: '#ffffff', mapTextureUrl: CROSSING, roughness: 0.95 },
  { id: 'plaza', color: '#ffffff', mapTextureUrl: BRICKS, roughness: 0.85 },
  { id: 'market', color: '#ffffff', mapTextureUrl: TERRACOTTA, roughness: 0.85 },
  { id: 'promenade', color: '#ffffff', mapTextureUrl: CONCRETE, roughness: 0.9 },
  { id: 'roof-red', color: '#ffffff', mapTextureUrl: roof('#b8603f', '#9d4c31'), roughness: 0.8 },
  { id: 'roof-slate', color: '#ffffff', mapTextureUrl: roof('#62707b', '#4f5b65'), roughness: 0.8 },
  { id: 'roof-teal', color: '#ffffff', mapTextureUrl: roof('#4f8f8b', '#3e7471'), roughness: 0.8 },
  ...SHOPS.map((shop, index): MeshConfig => ({ id: `shopfront-${index}`, color: shop.front, roughness: 0.8 })),
  ...SHOPS.map((shop, index): MeshConfig => ({ id: `shop-side-${index}`, color: shop.side, roughness: 0.85 })),
  { id: 'rail', color: '#f4f1ea', roughness: 0.6 },
);

const FLOOR: Record<string, string> = { ',': 'pavement', '#': 'crossing', g: 'lawn', P: 'plaza', k: 'market', q: 'promenade', d: 'floor' };

function tiles(): TileConfig[] {
  return tilesFromMap(MAP, (kind, x, z) => {
    if (kind === 'H') {
      const shop = SHOPS[Math.floor(x / 2)]!;
      return { y: shop.height, group: `shop-block-${Math.floor(x / 2)}`, materialId: shop.roof };
    }
    if (kind === '=') return { materialId: z === 3 ? 'road-north' : 'road-south' };
    return { materialId: FLOOR[kind] ?? 'pavement' };
  });
}

/** Each shop's front: a door and a shop window on the pavement, its own wall group so it keeps its colour. */
function fronts(): { groups: WallGroupConfig[]; signs: PlacedObject[] } {
  const groups = SHOPS.map((shop, index): WallGroupConfig => {
    const walls: WallConfig[] = [
      wall(`shop-${index}-door`, index * 2, 1, 'south', `shop-${index}`, 'door'),
      wall(`shop-${index}-window`, index * 2 + 1, 1, 'south', `shop-${index}`, 'window'),
    ];
    return { id: `shop-${index}`, name: shop.name, frontMeshId: `shopfront-${index}`, backMeshId: `shopfront-${index}`, sideMeshId: `shopfront-${index}`, walls };
  });
  const signs = SHOPS.map((shop, index) =>
    sign(`shop-${index}-sign`, at(index * 2) + 2, at(1) + 2.45, { text: shop.name, color: shop.sign, width: 2, height: 1.3, elevation: 2.7 }),
  );
  return { groups, signs };
}

/** The street's ground, and each shop's block, whose sides take its colour. */
const GROUPS = {
  ground: { name: 'ground', floorMeshId: 'pavement' },
  ...Object.fromEntries(SHOPS.map((shop, index) => [`shop-block-${index}`, { name: shop.name, floorMeshId: `shop-side-${index}` }])),
};

/** The kerbs of the pavements either side of the road. */
const KERB_NORTH = at(2) + 1.3;
const KERB_SOUTH = at(5) - 1.3;

/** The promenade's railing along the water. */
const railing = (): WallConfig[] => Array.from({ length: 14 }, (_, x) => wall(`rail-${x}`, x, 13, 'south', 'rail', 'railing'));

/** What the street waits for; each slot's line names the prop standing in for it now. */
const SLOTS = standIns(
  {
    'city-street-lamp': { prop: 'lamp-basic', scale: 2 },
    'city-traffic-light': { prop: 'deco-signpost' },
    'city-bus-stop': { prop: 'deco-notice-board' },
    'city-vending-machine': { prop: 'farm-veg-crate' },
    'city-hydrant': { prop: 'flower-pot' },
    'city-trash-bin': { prop: 'farm-barrel', scale: 0.9 },
    'city-planter': { prop: 'flower-tulip-bed' },
    'city-car': { prop: 'shop-stall-basic' },
  },
  [
    // Lamps on the kerbs, between the shops and along the south walk.
    ['city-street-lamp', 'lamp-n-a', -22, KERB_NORTH],
    ['city-street-lamp', 'lamp-n-b', -6, KERB_NORTH],
    ['city-street-lamp', 'lamp-n-c', 9.2, KERB_NORTH],
    ['city-street-lamp', 'lamp-s-a', -24, KERB_SOUTH],
    ['city-street-lamp', 'lamp-s-b', -12, KERB_SOUTH],
    ['city-street-lamp', 'lamp-s-c', -2, KERB_SOUTH],
    ['city-street-lamp', 'lamp-s-d', 24, KERB_SOUTH],
    ['city-street-lamp', 'lamp-walk-a', at(3), at(9) + 1.3],
    ['city-street-lamp', 'lamp-walk-b', at(10), at(9) + 1.3],
    ['city-street-lamp', 'lamp-plaza-w', at(5) - 1.2, at(7) - 0.4],
    ['city-street-lamp', 'lamp-plaza-e', at(11) + 1.2, at(7) - 0.4],
    ['city-street-lamp', 'lamp-pier-a', at(5), at(12) + 1.4],
    ['city-street-lamp', 'lamp-pier-b', at(9), at(12) + 1.4],
    // At the crossings.
    ['city-traffic-light', 'signal-west', at(3) - 2.6, KERB_NORTH, Math.PI],
    ['city-traffic-light', 'signal-east', at(10) + 2.6, KERB_SOUTH],
    ['city-bus-stop', 'bus-stop', at(12), at(5) - 1, Math.PI],
    ['city-vending-machine', 'vending', at(7) + 1.3, at(2) - 1.1],
    ['city-hydrant', 'hydrant', -10, KERB_NORTH],
    ['city-trash-bin', 'bin-plaza', at(6) - 0.4, at(6) - 1.2],
    ['city-trash-bin', 'bin-promenade', at(7), at(12) - 0.6],
    ['city-planter', 'planter-west', at(5) - 0.4, at(8) + 1],
    ['city-planter', 'planter-east', at(11) + 0.4, at(8) + 1],
    ['city-car', 'car', at(13) + 0.3, at(4) - 1.6, -Math.PI / 2],
  ],
);

function build(): BuildingSerializedState {
  const { groups, signs } = fronts();
  const [fountainX, fountainZ] = [at(8), at(7)];
  const objects: PlacedObject[] = [
    ...signs,
    // A pot of flowers by each shop door.
    ...SHOPS.map((_, index) => decor(`door-pot-${index}`, 'flower-pot', at(index * 2) - 1.5, at(2) - 1.2)),
    decor('mailbox', 'mailbox-basic', at(11) - 1.2, at(2) - 1),
    // The plaza: the fountain, benches round it, parasols and banners at its entrance.
    decor('fountain', 'deco-fountain', fountainX, fountainZ, 0, 1.8),
    decor('plaza-bench-n', 'deco-bench', fountainX, fountainZ - 3.4),
    decor('plaza-bench-s', 'deco-bench', fountainX, fountainZ + 3.4, Math.PI),
    decor('plaza-bench-w', 'deco-bench', fountainX - 4, fountainZ, Math.PI / 2),
    decor('plaza-bench-e', 'deco-bench', fountainX + 4, fountainZ, -Math.PI / 2),
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([dx, dz]) => decor(`plaza-pot-${dx}-${dz}`, 'flower-pot', fountainX + dx! * 2.4, fountainZ + dz! * 2.4)),
    decor('plaza-tree-w', 'nature-tree-round', at(6) - 1.6, at(7) + 0.6, 0.6),
    decor('plaza-tree-sw', 'nature-tree-round', at(5) + 0.8, at(8) - 0.8, 2.4),
    decor('plaza-parasol-a', 'deco-parasol-table', at(10) + 1.5, at(6) + 0.5),
    decor('plaza-parasol-b', 'deco-parasol-table', at(10) + 1.5, at(8) - 0.5),
    decor('plaza-hydrangea-w', 'flower-hydrangea', at(5) - 0.6, at(6) - 0.6),
    decor('plaza-hydrangea-e', 'flower-hydrangea', at(11) + 0.6, at(6) - 0.6),
    flag('plaza-flag-w', at(7) - 1.6, at(6) - 1.4, { color: '#ff8a65', width: 1.4, height: 0.9 }),
    flag('plaza-flag-e', at(9) + 1.6, at(6) - 1.4, { color: '#5a8acf', width: 1.4, height: 0.9 }),
    // The pocket park.
    tree('park-maple-a', 'maple', at(1) + 0.4, at(6) + 0.4, 3.6),
    tree('park-maple-b', 'maple', at(3) - 0.2, at(8) + 0.2, 3.4),
    tree('park-birch', 'birch', at(1), at(8) + 0.6, 3.2),
    decor('park-bird-bath', 'deco-bird-bath', at(2) + 0.6, at(7) - 0.4),
    decor('park-bench', 'deco-bench', at(3), at(6) - 0.6, Math.PI / 2),
    decor('park-tulips', 'flower-tulip-bed', at(2) + 0.6, at(8) + 1.2),
    // Street trees, between shop fronts and along the south walk.
    decor('street-tree-a', 'nature-tree-thin', -14, KERB_NORTH),
    decor('street-tree-b', 'nature-tree-thin', 2, KERB_NORTH, 1.2),
    decor('street-tree-c', 'nature-tree-thin', 18, KERB_NORTH, 2.4),
    decor('walk-tree-a', 'nature-tree-thin', at(0), at(9) + 0.6, 0.6),
    decor('walk-tree-b', 'nature-tree-thin', at(7) - 1, at(9) + 0.6, 1.8),
    decor('walk-tree-c', 'nature-tree-thin', at(13), at(9) + 0.6, 3),
    // The green strip above the promenade: round trees and benches facing the water.
    ...[1, 4, 9, 12].map((x, index) => decor(`strip-tree-${x}`, 'nature-tree-round', at(x), at(11) - 0.4, index * 1.7)),
    decor('strip-bench-a', 'deco-bench', at(2) + 2, at(11) + 0.6),
    decor('strip-bench-b', 'deco-bench', at(10) + 2, at(11) + 0.6),
    decor('strip-hydrangea-a', 'flower-hydrangea', at(5) + 0.4, at(11)),
    decor('strip-hydrangea-b', 'flower-hydrangea', at(8) - 0.4, at(11)),
    decor('signpost', 'deco-signpost', at(4) + 0.8, at(9)),
    // The market yards.
    decor('stall-west', 'shop-stall-basic', at(1) + 2, at(10) - 0.4),
    decor('crate-west', 'farm-veg-crate', at(0) + 0.2, at(10) + 0.4, 0.3),
    decor('barrel-west', 'farm-barrel', at(3) + 0.4, at(10) + 0.6),
    decor('stall-east', 'shop-stall-basic', at(10) + 2, at(10) - 0.4),
    decor('crate-east', 'farm-veg-crate', at(12) + 0.8, at(10) + 0.6, -0.4),
    decor('market-parasol', 'deco-parasol-table', at(9) - 0.6, at(10) + 0.4),
    // The promenade and its boardwalk: benches looking out to sea, a fish stall, pennants on the railing.
    decor('promenade-bench-a', 'deco-bench', at(3), at(13) + 0.8),
    decor('promenade-bench-b', 'deco-bench', at(11), at(13) + 0.8),
    decor('promenade-bench-c', 'deco-bench', at(7) + 2, at(13) + 0.8),
    decor('fish-stall', 'shop-stall-basic', at(1), at(12) + 0.2),
    decor('fish-barrel', 'farm-barrel', at(0) - 0.6, at(12) + 1.2),
    decor('fish-crate', 'farm-veg-crate', at(2) + 0.6, at(12) + 1, 0.2),
    ...[1, 5, 9, 13].map((x) => flag(`rail-flag-${x}`, at(x), at(13) + 1, { color: x % 4 === 1 ? '#5a8acf' : '#ff8a65', width: 1.2, height: 0.7 })),
    ...SLOTS.objects(),
  ];
  return {
    version: 1,
    meshes: MESHES,
    tileGroups: groupTiles(tiles(), GROUPS),
    wallGroups: [...groups, { id: 'rail', name: '난간', frontMeshId: 'rail', backMeshId: 'rail', sideMeshId: 'rail', walls: railing() }],
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

export const city: IslandTemplate = {
  id: 'city',
  label: '도시',
  build,
  areas: [area('plaza', 5, 6, 7, 3), area('park', 1, 6, 3, 3), area('road', 0, 3, 14, 2), area('promenade', 0, 12, 14, 2)],
  rules: [arrive('plaza', '⛲ 광장'), arrive('park', '🌳 쌈지 공원'), arrive('road', '🚦 큰길'), arrive('promenade', '⚓ 부두')],
  rooms: [],
  sky: CITY,
  residentSpots: [[-16, -20.2], [-2, 16], [-17, 1], [24, 1], [-2, -19.5], [24, -20], [-2, 0], [11, -2], [-8, -8], [-9, 12], [17, 12], [16, 8]],
  picture: '/islands/city.webp',
  slots: SLOTS.slots,
};
