import type { BuildingSerializedState, FarmCrop, MeshConfig, PlacedObject, TileConfig, WallConfig } from 'gaesup-world/building';

import { area, arrive, at, decor, DIRT, EARTH_MESH, groupTiles, model, ROAD, tilesFromMap, wall, withBaseMeshes, WOODED_GROUPS, woods } from './kit';
import { DAY, ROOM_LAMP, ROOM_LIGHT } from './sky';
import type { IslandTemplate } from './types';

/**
 * A farm: the farmhouse and an orchard in the north, fields either side of the lane, a pond and a produce stand.
 * T woods · . lawn · F farmhouse floor · o orchard · = lane · c k w p u r e fields · ~ pond · s beach
 */
const MAP = [
  'TTTTTTTTTTTTTT',
  'T.FFF..ooooo.T',
  'T.FFF..ooooo.T',
  'T.......=....T',
  'T.cc.kk.=.ww.T',
  'T.cc.kk.=.ww.T',
  'T.......=....T',
  'T.pp.uu.=====T',
  'T.pp.uu.=.~~.T',
  'T.......=.~~.T',
  'T.rr.ee.=....T',
  '........=.....',
  'ssssssss=sssss',
  'ssssssssssssss',
];
const HOUSE = { x0: 2, x1: 4, z0: 1, z1: 2 };
const CROPS: Record<string, FarmCrop> = { c: 'cabbage', k: 'carrot', w: 'wheat', p: 'pumpkin', u: 'corn', r: 'rice', e: 'strawberry' };

const MESHES: MeshConfig[] = withBaseMeshes(
  EARTH_MESH,
  { id: 'cabin-inside', color: '#d8b48a', roughness: 0.8 },
  { id: 'cabin-outside', color: '#8a5a36', roughness: 0.8 },
);

function tiles(): TileConfig[] {
  return tilesFromMap(MAP, (kind) => {
    if (kind === 'T') return { y: 1, group: 'woods', materialId: 'lawn', objectConfig: DIRT };
    if (kind === 'F') return { materialId: 'floor' };
    if (kind === '=') return { materialId: 'lawn', objectType: 'dirt', objectConfig: ROAD };
    if (kind === '~') return { objectType: 'water' };
    if (kind === 's') return { objectType: 'sand' };
    const crop = CROPS[kind];
    if (crop) return { materialId: 'field', objectType: 'farm', objectConfig: { farm: { crop, edge: 'wood' } } };
    return { materialId: 'lawn' };
  });
}

/** Log walls on three sides; the south stays open to the yard. */
function walls(): WallConfig[] {
  const list: WallConfig[] = [];
  for (let x = HOUSE.x0; x <= HOUSE.x1; x++) list.push(wall(`house-north-${x}`, x, HOUSE.z0, 'north', 'house', x === HOUSE.x0 + 1 ? 'window' : 'solid'));
  for (let z = HOUSE.z0; z <= HOUSE.z1; z++) {
    list.push(wall(`house-west-${z}`, HOUSE.x0, z, 'west', 'house', z === HOUSE.z1 ? 'window' : 'solid'));
    list.push({ ...wall(`house-east-${z}`, HOUSE.x1, z, 'east', 'house', z === HOUSE.z1 ? 'window' : 'solid'), flipSides: true });
  }
  return list;
}

const BACK = at(HOUSE.z0) - 2 + 0.25;
const WEST = at(HOUSE.x0) - 2 + 0.25;
const EAST = at(HOUSE.x1) + 2 - 0.25;

function build(): BuildingSerializedState {
  const objects: PlacedObject[] = [
    // The farmhouse.
    decor('house-bed', 'bed-basic', WEST + 1.1, BACK + 2.1),
    decor('house-shelf', 'storage-basic', WEST + 4.4, BACK + 0.45),
    decor('house-lamp', 'lamp-basic', WEST + 6.2, BACK + 0.5),
    decor('house-table', 'table-basic', EAST - 3.2, BACK + 3.2, Math.PI / 2),
    decor('house-chair-n', 'chair-basic', EAST - 3.2, BACK + 1.8),
    decor('house-chair-s', 'chair-basic', EAST - 3.2, BACK + 4.6, Math.PI),
    decor('house-bench', 'crafting-basic', EAST - 0.6, BACK + 6, -Math.PI / 2),
    // The yard in front of it.
    model('mailbox', 'mailbox-basic', at(5) - 1, at(3) - 1),
    decor('well', 'deco-well', at(6), at(3)),
    decor('wheelbarrow', 'farm-wheelbarrow', at(1) + 0.6, at(3) + 0.4, 0.5),
    decor('hay-a', 'farm-hay-bale', at(2) + 0.2, at(3) + 0.8),
    decor('hay-b', 'farm-hay-bale', at(3) - 0.6, at(3) + 1, 0.4),
    decor('pumpkins', 'crop-pumpkin', at(4), at(3) + 0.6),
    // The orchard: apple trees in two rows, and the hives.
    ...[7, 9, 11].map((x, index) => model(`apple-${x}`, 'nature-tree-oak', at(x), at(1) - 0.6, index * 1.3)),
    ...[8, 10].map((x, index) => model(`apple-${x}`, 'nature-tree-oak', at(x), at(2) + 0.8, 2.1 + index)),
    model('apple-12', 'nature-tree-oak', at(12), at(2) + 0.8, 4.4, 0.9),
    decor('hive-a', 'farm-beehive', at(8), at(1) - 0.6),
    decor('hive-b', 'farm-beehive', at(10), at(1) - 0.6, 0.3),
    // Along the fields.
    decor('scarecrow-cabbage', 'farm-scarecrow', at(2) + 2, at(4) + 2),
    decor('scarecrow-wheat', 'farm-scarecrow', at(10) + 2, at(4) + 2, -0.3),
    decor('can-a', 'farm-watering-can', at(4), at(4) + 0.4, 0.6),
    decor('can-b', 'farm-watering-can', at(4) + 0.6, at(8) - 0.8, 2.2),
    decor('crate-a', 'farm-veg-crate', at(4) - 0.4, at(5) + 1),
    decor('crate-b', 'farm-veg-crate', at(7) - 0.6, at(8) + 1.2, 0.2),
    decor('barrel-a', 'farm-barrel', at(7) - 1, at(3) - 1.2),
    decor('hay-c', 'farm-hay-bale', at(12) + 0.6, at(6), 1.2),
    decor('hay-d', 'farm-hay-bale', at(9) + 0.4, at(6) + 1.2, 0.2),
    decor('corn', 'crop-corn', at(4), at(7) + 2),
    decor('wheat', 'crop-wheat', at(12) + 0.4, at(4) + 0.4),
    ...[4, 5].map((z) => decor(`sunflower-w-${z}`, 'flower-sunflower', at(7) - 0.6, at(z), z)),
    ...[4, 5].map((z) => decor(`sunflower-e-${z}`, 'flower-sunflower', at(9) + 0.8, at(z) + 0.4, z + 2)),
    // Fences along the lane where it runs between fields.
    ...[-13, -11, -9, -7, -1, 1, 3, 5].map((z) => decor(`fence-lane-w${z}`, 'fence-basic', at(8) - 2.4, z, Math.PI / 2)),
    ...[-13, -11, -9, -7].map((z) => decor(`fence-lane-e${z}`, 'fence-basic', at(8) + 2.4, z, Math.PI / 2)),
    // The pond, and the stand selling what grows here.
    model('lily-a', 'nature-lily', at(10) + 0.4, at(8) + 0.6, 0.3, 2),
    model('lily-b', 'nature-lily', at(11) - 0.6, at(9) - 0.4, 1.9, 2),
    model('lily-c', 'nature-lily', at(11) + 0.8, at(8) - 0.8, 4.1, 1.8),
    decor('stand', 'shop-stall-basic', at(11), at(10) + 0.4),
    decor('stand-crate-a', 'farm-veg-crate', at(11) - 2.2, at(10) + 1.2, 0.4),
    decor('stand-crate-b', 'farm-veg-crate', at(11) + 2.2, at(10) + 1.2, -0.3),
    decor('stand-barrel', 'farm-barrel', at(12) + 1.2, at(9) + 1),
    decor('barrel-b', 'farm-barrel', at(9) + 1.4, at(11)),
    ...woods(MAP, ['nature-tree-round', 'nature-tree-pine', 'nature-tree-fat', 'nature-tree-oak', 'nature-tree-pine'], 1, (x, z) => z === 0 && x <= HOUSE.x1 + 1),
  ];
  return {
    version: 1,
    meshes: MESHES,
    tileGroups: groupTiles(tiles(), WOODED_GROUPS),
    wallGroups: [{ id: 'house', name: '농가', frontMeshId: 'cabin-inside', backMeshId: 'cabin-outside', sideMeshId: 'cabin-outside', walls: walls() }],
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

const house = area('farmhouse', HOUSE.x0, HOUSE.z0, HOUSE.x1 - HOUSE.x0 + 1, HOUSE.z1 - HOUSE.z0 + 1);

export const farm: IslandTemplate = {
  id: 'farm',
  label: '농장',
  build,
  areas: [house, area('fields', 2, 4, 5, 5), area('orchard', 7, 1, 5, 2), area('beach', 0, 12, 14, 2)],
  rules: [arrive('farmhouse', '🏡 농가'), arrive('fields', '🌾 밭'), arrive('orchard', '🍎 과수원'), arrive('beach', '🌊 해변')],
  rooms: [{ id: 'farmhouse', center: [...house.center], size: [...house.size], profile: ROOM_LIGHT, lamp: ROOM_LAMP }],
  sky: DAY,
  residentSpots: [[4, -14], [4, 16], [-19, -4], [20, 1], [20, -24], [0, 1], [-16, -21], [-12, 9], [10, -5], [-4, -24], [14, -16], [-9, -4]],
  picture: '/islands/farm.webp',
  slots: [],
};
