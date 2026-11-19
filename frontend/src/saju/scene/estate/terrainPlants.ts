import type { Terrain } from '../../../api/types';
import type { Builder, V3 } from '../build';
import { bush, conifer, rock, tree } from '../plants';
import type { Placement } from './layout';

const FROST = ['#76988f', '#8caea2', '#d1e3df', '#abc8c0'];
const SPRUCE = ['#496f66', '#5b796e', '#739087'];
const SNOW = ['#cfdddd', '#e8f1ef', '#e1ecee'];
const OLIVE = ['#929564', '#9c9c65', '#7d885a', '#a8a373'];
const MOSS = ['#75925b', '#567552', '#a0b46a'];

/**
 * Wild growth follows the surface. The orchard, flower beds, stream and the chart's named motifs keep their places; the
 * grounds of paths (자갈, 흙) keep the island's own growth.
 */
export function terrainPlant(b: Builder, terrain: Terrain | undefined, p: Placement): boolean {
  if (!terrain || terrain === 'default' || terrain === 'gravel' || terrain === 'soil') return false;
  const [x, z] = p.at;
  const at: V3 = [x, 0, z];
  if (terrain === 'snow') {
    if (p.kind === 'tree' && p.tree && (p.tree.species === 'fir' || p.tree.species === 'cypress')) {
      const { height, spread } = p.tree;
      conifer(b, at, { height, radius: spread * 0.48, bark: '#65574e', needles: SPRUCE, snow: SNOW, tiers: 5 });
    } else if (p.kind === 'tree' && p.tree) {
      tree(b, at, { ...p.tree, bark: '#706963', leaves: FROST, density: 0.16, lobes: 5 });
    } else if (p.kind === 'bush' || p.kind === 'rocks' || p.kind === 'wildflowers') {
      const size = p.scale * (p.kind === 'bush' ? 0.72 : 0.4);
      rock(b, at, size, '#7b8d94', 0.55);
      b.dome([size * 0.74, size * 0.24, size * 0.62], [x, size * 0.24, z], '#e6f1f5', { rough: 0.92, detail: 10 });
    } else return p.kind === 'ferns' || p.kind === 'meadow';
    return true;
  }
  if (terrain === 'desert') {
    if (p.kind === 'tree' && p.tree) {
      if (p.seed % 3 === 0 || p.id.startsWith('year:bank:')) {
        tree(b, at, { height: p.tree.height * 0.72, spread: p.tree.spread, bark: '#73604c', leaves: OLIVE, flat: 0.32, density: 0.68, lobes: 4 });
      } else {
        rock(b, at, p.tree.height * 0.24, '#b98a63', 0.7);
      }
    } else if (p.kind === 'bush' || p.kind === 'ferns') {
      const height = Math.max(0.45, p.scale);
      b.cyl(height * 0.13, height * 0.85, [x, height * 0.43, z], '#819777', { sides: 9 });
      b.dome([height * 0.13, height * 0.13, height * 0.13], [x, height * 0.85, z], '#819777', { detail: 9 });
      for (const side of [-1, 1]) {
        const y = height * (side < 0 ? 0.36 : 0.48);
        b.limb([[x, y, z], [x + side * height * 0.23, y + 0.08, z], [x + side * height * 0.23, y + height * 0.36, z]], [height * 0.075], '#8b9e78', { sides: 8 });
      }
    } else return p.kind === 'wildflowers' || p.kind === 'meadow';
    return true;
  }
  if (p.kind === 'rocks' || p.kind === 'wildflowers') {
    rock(b, at, p.scale * 0.53, '#6c7969', 0.52);
    bush(b, [x - p.scale * 0.24, 0.05, z], p.scale * 0.32, MOSS);
    return true;
  }
  return false;
}
