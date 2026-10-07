import type { BuildingSerializedState, MeshConfig, PlacedObject, TileConfig } from 'gaesup-world/building';

import { area, arrive, at, decor, DIRT, EARTH_MESH, fire, flag, forestFloor, groupTiles, model, PLANKS, ROAD, standIns, TALL_GRASS, tilesFromMap, withBaseMeshes, WOODED_GROUPS, woods } from './kit';
import { GOLDEN } from './sky';
import type { IslandTemplate } from './types';

/**
 * A campsite in a clearing of pine woods: a lake in the north, decks for tents, a ring round the campfire.
 * T woods · . grass · ~ lake · d deck · = trail · o fire ring · " tall grass
 */
const MAP = [
  'TTTTTTTTTTTTTT',
  'TTTTT..~~~~TTT',
  'TTT....~~~~~TT',
  'TT..dd..~~~..T',
  'TT..dd.......T',
  'T......=......',
  'T..oo..=..dd..',
  'T..oo..=..dd.T',
  'T......=.....T',
  'TT..........TT',
  'TTT..""..""TTT',
  'TTTT......TTTT',
  'TTTTT....TTTTT',
  'TTTTTTTTTTTTTT',
];

const MESHES: MeshConfig[] = withBaseMeshes(EARTH_MESH, { id: 'deck', color: '#ffffff', mapTextureUrl: PLANKS, roughness: 0.75 });

function tiles(): TileConfig[] {
  return tilesFromMap(MAP, (kind) => {
    if (kind === 'T') return { y: 1, group: 'woods', materialId: 'lawn', objectConfig: DIRT };
    if (kind === '~') return { objectType: 'water' };
    if (kind === 'd') return { materialId: 'deck' };
    if (kind === '=' || kind === 'o') return { materialId: 'lawn', objectType: 'dirt', objectConfig: ROAD };
    if (kind === '"') return { materialId: 'lawn', objectType: 'grass', objectConfig: { grassDensity: TALL_GRASS } };
    return { materialId: 'lawn' };
  });
}

/** The board at the trail into the woods: planks and an arrow along it. */
const TRAIL_SIGN = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64" viewBox="0 0 240 64"><rect width="240" height="64" rx="8" fill="#9a6a40"/>' +
    '<path d="M0 22h240M0 42h240" stroke="#7d5330" stroke-width="3"/><path d="M60 32h110M150 16l24 16-24 16" fill="none" stroke="#f4ead6" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
)}`;

/** The campfire, in the middle of its ring. */
const FIRE = [at(3) + 2, at(6) + 2] as const;

/** What the campsite waits for; each slot's line names the prop standing in for it now. */
const SLOTS = standIns(
  {
    'camp-tent': { prop: 'deco-parasol-table' },
    'camp-chair': { prop: 'nature-stump' },
    'camp-lantern': { prop: 'deco-stone-lantern' },
    'camp-firewood': { prop: 'nature-fallen-log', scale: 0.8 },
    'camp-cooler': { prop: 'farm-veg-crate' },
  },
  [
    ['camp-tent', 'tent-north', at(4) + 0.6, at(3) + 0.4],
    ['camp-tent', 'tent-east', at(11) + 0.6, at(6) + 0.2],
    ['camp-chair', 'chair-sw', FIRE[0] - 1.9, FIRE[1] + 2.2, 0.4],
    ['camp-chair', 'chair-se', FIRE[0] + 1.9, FIRE[1] + 2.2, 2.1],
    ['camp-lantern', 'lantern-a', FIRE[0] - 4.2, FIRE[1] - 3],
    ['camp-lantern', 'lantern-b', FIRE[0] + 4.2, FIRE[1] - 3],
    ['camp-firewood', 'firewood', FIRE[0] - 4.2, FIRE[1] + 1.4, Math.PI / 2],
    ['camp-cooler', 'cooler-north', at(5) + 1.4, at(4) + 1.4],
    ['camp-cooler', 'cooler-east', at(11) + 1.4, at(7) + 1.4],
  ],
);

function build(): BuildingSerializedState {
  const objects: PlacedObject[] = [
    // The fire ring: logs to sit on round the fire.
    fire('campfire', FIRE[0], FIRE[1], 1.4),
    decor('ring-log-n', 'nature-fallen-log', FIRE[0], FIRE[1] - 2.6, 0),
    decor('ring-log-e', 'nature-fallen-log', FIRE[0] + 2.6, FIRE[1], Math.PI / 2),
    decor('ring-log-w', 'nature-fallen-log', FIRE[0] - 2.6, FIRE[1], Math.PI / 2),
    // On the decks: hay and a barrel by the north one's tent, a picnic table on the east one.
    decor('deck-hay-a', 'farm-hay-bale', at(4) + 0.4, at(4) + 0.8),
    decor('deck-hay-b', 'farm-hay-bale', at(5) + 0.2, at(4) + 1.2, 0.5),
    decor('deck-barrel', 'farm-barrel', at(5) + 1.4, at(3) - 1),
    decor('deck-picnic', 'deco-picnic-table', at(10) + 0.4, at(7) + 0.8, Math.PI / 2),
    decor('barrel-b', 'farm-barrel', at(12) - 0.4, at(5) + 0.6),
    model('stump-a', 'nature-stump', at(9) + 1.4, at(7) + 1.4, 1),
    model('stump-b', 'nature-stump', at(2), at(8) + 0.6, 2.8),
    // Camp pennants, and the sign at the trail into the woods.
    flag('pennant-a', at(3) - 1.6, at(5) - 0.8, { color: '#e5534b', width: 1.2, height: 0.8 }),
    flag('pennant-b', at(6) + 1.2, at(5) - 0.8, { color: '#e89b16', width: 1.2, height: 0.8 }),
    flag('pennant-c', at(12) - 0.6, at(6) - 1.6, { color: '#2bb3a3', width: 1.2, height: 0.8 }),
    flag('trail-sign', at(7), at(11) - 1, { style: 'placard', color: '#8a5a36', picture: TRAIL_SIGN, width: 3, height: 0.8 }),
    // The lake shore.
    model('lily-a', 'nature-lily', at(8) + 0.4, at(1) + 0.6, 0.3, 2),
    model('lily-b', 'nature-lily', at(10) - 0.6, at(2) - 0.4, 1.9, 2),
    model('lily-c', 'nature-lily', at(9) + 0.8, at(3) - 0.8, 4.1, 1.8),
    model('shore-rock-a', 'nature-rock-round', at(7) - 1.2, at(3) + 0.6, 0.8),
    model('shore-rock-b', 'nature-rock-wide', at(12) - 0.6, at(3) + 0.4, 2.4),
    model('rock-c', 'nature-rock-moss', at(1) + 1.2, at(5) + 0.6, 1.3),
    model('rock-d', 'nature-rock-small', at(11) + 0.6, at(9) + 0.6, 2.7),
    model('mushrooms-a', 'nature-mushroom-cluster', at(2) + 1, at(7) + 1.4),
    model('mushrooms-b', 'nature-mushroom-cluster', at(10) - 1.4, at(9) + 1.2, 1.2),
    model('mushrooms-c', 'nature-mushroom-cluster', at(5) + 1.4, at(9) - 0.6, 2.4),
    model('mushrooms-d', 'nature-mushroom-cluster', at(5), at(11), 0.6),
    ...SLOTS.objects(),
    ...forestFloor(MAP, ['nature-fern', 'nature-fern', 'nature-stump', 'nature-mushroom-cluster'], (x, z) => (x === 1 && z === 5) || (x === 11 && z === 9)),
    ...woods(MAP, ['nature-tree-pine', 'nature-tree-pine', 'nature-tree-thin', 'nature-tree-pine', 'nature-tree-round']),
  ];
  return {
    version: 1,
    meshes: MESHES,
    tileGroups: groupTiles(tiles(), WOODED_GROUPS),
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

export const camp: IslandTemplate = {
  id: 'camp',
  label: '캠핑',
  build,
  areas: [area('campfire', 3, 6, 2, 2), area('decks', 4, 3, 2, 2), area('lake', 7, 1, 5, 3)],
  rules: [arrive('campfire', '🔥 모닥불'), arrive('decks', '🏕️ 캠프장'), arrive('lake', '🛶 호수')],
  rooms: [],
  sky: GOLDEN,
  residentSpots: [[4, -12], [4, 16], [-21, -4], [24, -4], [-14, -20], [-3, 2], [12, 4], [17, -16], [-8, -9], [12, -6], [-13, 8], [-4, -19]],
  picture: '/islands/camp.webp',
  slots: SLOTS.slots,
};
