import type { BuildingSerializedState, MeshConfig, PlacedObject, TileConfig } from 'gaesup-world/building';

import { area, arrive, at, decor, DIRT, EARTH_MESH, groupTiles, model, noise, scatter, svg, TALL_GRASS, tilesFromMap, tree, withBaseMeshes, WOODED_GROUPS, woods } from './kit';
import { DAY } from './sky';
import type { IslandTemplate } from './types';

/**
 * A park: a gravel loop round a fountain plaza, a duck pond, a picnic lawn and flower beds, woods behind.
 * T woods · . lawn · * flower bed · = gravel walk · P plaza · ~ pond · l picnic lawn · " tall grass · s beach
 */
const MAP = [
  'TTTTTTTTTTTTTT',
  'T..**..**..**T',
  'T.==========.T',
  'T.=..PPPP..=.T',
  'T.=..PPPP..=.T',
  'T.==========.T',
  'T.=.~~~.ll.=.T',
  'T.=.~~~.ll.=.T',
  'T.=........=.T',
  'T.=.""..**.=.T',
  'T.=.""..**.=.T',
  '...=========..',
  'ssssss==ssssss',
  'ssssssssssssss',
];

const GRAVEL = svg(
  scatter(70, 41, (x, y, i) => `<circle cx="${x}" cy="${y}" r="${1.4 + (i % 3) * 0.6}" fill="${['#cfc5b0', '#b9ad95', '#e2d9c6'][i % 3]}"/>`),
  '#d8cdb6',
);
const PLAZA_STONE = svg(
  [0, 64].map((y) => [0, 64].map((x) => `<rect x="${x + 2}" y="${y + 2}" width="60" height="60" rx="4" fill="#e9e2d2"/>`).join('')).join('') +
    `<path d="M0 32h128M0 96h128M32 0v128M96 0v128" stroke="#d6cdb9" stroke-width="2"/>`,
  '#cbbfa6',
);

const MESHES: MeshConfig[] = withBaseMeshes(
  EARTH_MESH,
  { id: 'gravel', color: '#ffffff', mapTextureUrl: GRAVEL, roughness: 1 },
  { id: 'plaza-stone', color: '#ffffff', mapTextureUrl: PLAZA_STONE, roughness: 0.8 },
);

function tiles(): TileConfig[] {
  return tilesFromMap(MAP, (kind) => {
    if (kind === 'T') return { y: 1, group: 'woods', materialId: 'lawn', objectConfig: DIRT };
    if (kind === '*') return { materialId: 'flowers' };
    if (kind === '=') return { materialId: 'gravel' };
    if (kind === 'P') return { materialId: 'plaza-stone' };
    if (kind === '~') return { objectType: 'water' };
    if (kind === '"') return { materialId: 'lawn', objectType: 'grass', objectConfig: { grassDensity: TALL_GRASS } };
    if (kind === 's') return { objectType: 'sand' };
    return { materialId: 'lawn' };
  });
}

function build(): BuildingSerializedState {
  const [fx, fz] = [at(6) + 2, at(3) + 2];
  const objects: PlacedObject[] = [
    // The plaza: the fountain, benches round it, a sundial and the two statues at its south corners.
    decor('fountain', 'deco-fountain', fx, fz, 0, 1.8),
    decor('plaza-bench-w', 'deco-bench', fx - 5, fz, Math.PI / 2),
    decor('plaza-bench-e', 'deco-bench', fx + 5, fz, -Math.PI / 2),
    decor('plaza-bench-nw', 'deco-bench', fx - 3, fz - 2.9),
    decor('plaza-bench-ne', 'deco-bench', fx + 3, fz - 2.9),
    decor('sundial', 'deco-sundial', at(4) + 0.6, at(4) - 0.4),
    decor('statue-fox', 'deco-statue-fox', at(5) - 1.2, at(4) + 1.2, Math.PI / 6),
    decor('statue-bear', 'deco-statue-bear', at(8) + 1.4, at(4) + 1.2, -Math.PI / 6),
    // Lamps inside the loop's corners and along it.
    decor('lamp-nw', 'lamp-basic', at(3) - 1.2, at(3) - 1.2, 0, 2),
    decor('lamp-ne', 'lamp-basic', at(10) + 1.2, at(3) - 1.2, 0, 2),
    decor('lamp-sw', 'lamp-basic', at(3) - 1.2, at(10) + 1.2, 0, 2),
    decor('lamp-se', 'lamp-basic', at(10) + 1.2, at(10) + 1.2, 0, 2),
    decor('lamp-w', 'lamp-basic', at(3) - 1.2, at(7), 0, 2),
    decor('lamp-e', 'lamp-basic', at(10) + 1.2, at(7), 0, 2),
    decor('lamp-walk-w', 'lamp-basic', at(4), at(4) + 1.4, 0, 2),
    decor('lamp-walk-e', 'lamp-basic', at(10), at(4) + 1.4, 0, 2),
    // Flower beds along the woods.
    decor('tulips-a', 'flower-tulip-bed', at(3) + 2, at(1)),
    decor('tulips-b', 'flower-tulip-bed', at(7) + 2, at(1)),
    decor('tulips-c', 'flower-tulip-bed', at(11) + 2, at(1)),
    decor('notice-board', 'deco-notice-board', at(5) + 2, at(1) - 0.6),
    decor('roses-a', 'flower-rose-bush', at(1), at(1) + 0.2),
    decor('roses-b', 'flower-rose-bush', at(9) + 2, at(1) - 0.2),
    // The pond, its lilies and rocks, a bench facing it.
    model('lily-a', 'nature-lily', at(4) + 0.4, at(6) + 0.6, 0.3, 2),
    model('lily-b', 'nature-lily', at(5) + 0.6, at(7) - 0.2, 1.9, 2),
    model('lily-c', 'nature-lily', at(6) - 0.4, at(6) - 0.6, 4.1, 1.8),
    model('lily-d', 'nature-lily', at(5) - 1.2, at(7) + 0.9, 2.6, 2),
    model('pond-rock-a', 'nature-rock-round', at(3) + 0.8, at(6) - 0.4, 0.8),
    model('pond-rock-b', 'nature-rock-wide', at(7) - 0.4, at(7) + 1.2, 2.4),
    model('pond-rock-c', 'nature-rock-round', at(4) - 0.6, at(8) + 0.2, 4.4, 0.8),
    decor('pond-bench', 'deco-bench', at(5), at(8) + 0.4, Math.PI),
    decor('hydrangea-a', 'flower-hydrangea', at(3) + 0.6, at(8) + 1.4),
    decor('hydrangea-b', 'flower-hydrangea', at(7) + 0.6, at(8) + 0.2),
    // The picnic lawn.
    decor('picnic-a', 'deco-picnic-table', at(8) + 0.4, at(6) + 1.2),
    decor('picnic-b', 'deco-picnic-table', at(9) + 0.6, at(7) + 1.2, Math.PI / 2),
    decor('bird-bath', 'deco-bird-bath', at(10), at(6) - 0.4),
    // Flowers and tall grass in the south.
    decor('lavender-a', 'flower-lavender', at(8) + 2, at(9) - 0.6),
    decor('lavender-b', 'flower-lavender', at(8) + 2, at(10) + 0.6),
    decor('daisy-a', 'flower-daisy', at(6) + 0.4, at(9) - 0.2),
    decor('daisy-b', 'flower-daisy', at(6) - 0.6, at(10) + 0.8),
    decor('daisy-c', 'flower-daisy', at(7) + 0.4, at(10) - 0.6),
    decor('signpost', 'deco-signpost', at(2), at(11) + 0.6),
    decor('arch', 'deco-flower-arch', at(6) + 2, at(12) + 0.2),
    // Hedges in the lawn strips either side, and trees in the park.
    ...[3, 6, 9].flatMap((z) => [
      model(`hedge-w-${z}`, 'nature-bush', at(1), at(z) + 1, noise(1, z, 7) * Math.PI * 2),
      model(`hedge-e-${z}`, 'nature-bush', at(12), at(z) + 1, noise(12, z, 7) * Math.PI * 2),
    ]),
    model('hedge-s-w', 'nature-bush', at(1), at(11), 0.4),
    model('hedge-s-e', 'nature-bush', at(12) + 0.4, at(11), 2.2),
    tree('maple-a', 'maple', at(9) + 1, at(4) - 0.6, 3.6),
    tree('maple-b', 'maple', at(3) - 0.2, at(9) + 0.2, 3.4),
    tree('birch-a', 'birch', at(10) - 0.6, at(8) + 0.6, 3.2),
    tree('birch-b', 'birch', at(4) + 0.4, at(3) - 0.8, 3.2),
    tree('oak-a', 'oak', at(12) + 0.4, at(5), 3.8),
    tree('oak-b', 'oak', at(1) - 0.2, at(5), 3.8),
    tree('sakura-a', 'sakura', at(3), at(7) + 0.5, 3.4),
    tree('sakura-b', 'sakura', at(10) + 0.4, at(10) - 0.4, 3.4),
    ...woods(MAP, ['nature-tree-round', 'nature-tree-fat', 'nature-tree-oak', 'nature-tree-round']),
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

export const park: IslandTemplate = {
  id: 'park',
  label: '공원',
  build,
  areas: [area('plaza', 5, 3, 4, 2), area('pond', 4, 6, 3, 2), area('picnic', 8, 6, 2, 2), area('beach', 0, 12, 14, 2)],
  rules: [arrive('plaza', '⛲ 분수 광장'), arrive('pond', '🦆 연못'), arrive('picnic', '🧺 피크닉 잔디'), arrive('beach', '🌊 해변')],
  rooms: [],
  sky: DAY,
  residentSpots: [[5, -14], [4, 16], [-19, -2], [20, 1], [-14, -22], [20, -24], [2, 1], [-10, 10], [-7, -9], [17, -11], [-2, -24], [10, -4]],
  picture: '/islands/park.webp',
  slots: [],
};
