import { useMemo } from 'react';

import type { ElementPiece } from '../elementalDecor';
import { jar } from './arch';
import { Builder, type Build, type V3 } from './build';
import { Built } from './Built';
import { lilies, pine, toned, tree } from './plants';

const base: V3 = [0, 0, 0];
const flat: V3 = [Math.PI / 2, 0, 0];
const metal = { metal: 0.65, rough: 0.32 };
const glaze = { rough: 0.23 };
const accent = { wood: '#79a68c', fire: '#b8483b', earth: '#bb7947', metal: '#c59b58', water: '#345f90' };

function basin(b: Builder, color: string, water = false) {
  b.cyl(0.42, 0.29, [0, 0.17, 0], color, { top: 0.61, ...glaze });
  b.ring(0.58, 0.045, [0, 0.32, 0], toned(color, 1.12), glaze, flat);
  b.cyl(0.555, 0.014, [0, 0.32, 0], water ? '#80c8c1' : '#5e4733', water ? glaze : {});
}

function post(b: Builder, x: number, height: number, color: string) {
  b.cyl(0.16, 0.16, [x, 0.08, 0], '#a09b87', { top: 0.14, sides: 8 });
  b.box([0.13, height, 0.13], [x, height / 2, 0], color, { surface: 'wood' });
}

/** The inventory illustrations are translated into geometry so each object can be turned and lit in the garden. */
export function buildOrnament(piece: ElementPiece, dye?: string): Build {
  const b = new Builder(731 + piece.ref.charCodeAt(0));
  const c = dye ?? accent[piece.element];
  switch (piece.ref) {
    case 'pine-bonsai':
      basin(b, c);
      pine(b, [0, 0.32, 0], { height: 1.45, spread: 1.45, needles: ['#496a40', '#607e45', '#839855'] });
      break;
    case 'plum-planter':
      basin(b, c);
      tree(b, [0, 0.32, 0], { height: 1.45, spread: 1.25, bark: '#6f4835', leaves: ['#81935e','#6f8449'], density: 0.45,
        blooms: { colors: ['#fff0db','#eaa4a2'], share: 0.8, size: 0.09 }, fruit: '#ae4140' });
      break;
    case 'bamboo-wheel':
      for (const x of [-0.53, 0.53]) post(b, x, 1.5, '#806043');
      b.box([1.24, 0.12, 0.34], [0, 1.52, 0], '#6f5841');
      b.ring(0.44, 0.04, [0, 0.86, 0.09], '#b89f6e');
      for (let i = 0; i < 8; i++) {
        b.group([0, 0.86, 0.09], () => {
          b.box([0.035, 0.48, 0.055], [0, 0.23, 0], '#b08a59');
          b.cyl(0.068, 0.2, [0, 0.37, 0.05], c, { sides: 8 }, [1.1, 0, 0]);
        }, [0, 0, i * Math.PI / 4]);
      }
      break;
    case 'lotus-lamp':
      b.cyl(0.33, 0.24, [0, 0.12, 0], '#a0907d', { sides: 8, top: 0.28 });
      b.cyl(0.24, 0.56, [0, 0.54, 0], '#ffd591', { sides: 6, glow: '#ffc46b', power: 1.3 });
      for (let i = 0; i < 6; i++) {
        b.group([0, 0, 0], () => {
          b.box([0.042, 0.51, 0.042], [0, 0.57, 0.23], '#965349');
          for (const y of [0.34, 0.88]) b.ball(0.19, [0, y, 0.25], c, { scale: [0.7, 0.72, 1.2] }, [-0.48, 0, 0]);
        }, i * Math.PI / 3);
      }
      b.cone(0.35, 0.22, [0, 0.94, 0], c, { sides: 6 });
      b.ball(0.07, [0, 1.08, 0], '#d4a372');
      break;
    case 'copper-brazier':
      for (const x of [-0.25, 0.25]) for (const z of [-0.21, 0.21]) b.cyl(0.08, 0.3, [x, 0.15, z], '#84563c', metal);
      b.cyl(0.27, 0.33, [0, 0.39, 0], dye ?? '#ad744e', { top: 0.48, ...metal });
      b.ring(0.46, 0.045, [0, 0.56, 0], '#dca36e', metal, flat);
      for (const x of [-0.22, 0, 0.22]) b.limb([[x, 0.55, 0], [x + 0.05, 0.76, 0.04], [x - 0.035, x === 0 ? 1.17 : 0.97, 0]], [0.11, 0.08, 0.001], '#ffbe57', { glow: '#ff982e', power: 1.25 });
      break;
    case 'vermilion-lamp':
      post(b, -0.34, 1.7, c);
      b.box([0.96, 0.14, 0.14], [0.04, 1.68, 0], c);
      b.limb([[0.36, 1.68, 0], [0.36, 1.39, 0]], [0.02, 0.02], '#66543d');
      b.cone(0.34, 0.2, [0.36, 1.33, 0], '#5d504d', { sides: 6 });
      b.cyl(0.21, 0.42, [0.36, 1.03, 0], '#ffd494', { sides: 6, glow: '#ffc570', power: 1.1 });
      for (const x of [0.18, 0.54]) for (const z of [-0.1, 0.1]) b.box([0.035, 0.44, 0.035], [x, 1.04, z], c);
      b.cyl(0.24, 0.07, [0.36, 0.81, 0], c);
      break;
    case 'ochre-cairn':
      for (let i = 0; i < 4; i++) {
        const radius = 0.53 - i * 0.09;
        b.ball(radius, [i % 2 === 0 ? -0.03 : 0.04, [0.2, 0.55, 0.82, 1.03][i]!, 0], toned(c, 0.76 + i * 0.13),
          { scale: [1, 0.43, 0.87], detail: 7 }, i * 0.45);
      }
      break;
    case 'harvest-jar':
      jar(b, base, 2.15, c);
      b.ring(0.4, 0.037, [0, 0.68, 0], '#ddbb75', {}, flat);
      for (let i = 0; i < 5; i++) b.ball(0.075, [0.18 + i * 0.042, 0.55 - (i % 3) * 0.055, 0.34 - i * 0.025], '#dfb464', { scale: [0.6, 2, 0.64] }, [0, 0, i * 0.15]);
      break;
    case 'clay-peaks':
      b.ball(0.7, [0, 0.08, 0], toned(c, 0.8), { scale: [1, 0.16, 0.77], detail: 8 });
      for (const [x, h, z] of [[-0.31, 0.73, 0.09],[0.04, 1.31,-0.04],[0.32, 0.59, 0.15]] as const)
        b.cone(0.35, h, [x, h / 2, z], toned(c, 1.12 - z), { sides: 5 }, x);
      break;
    case 'silver-bell':
      for (const x of [-0.49, 0.49]) post(b, x, 1.02, c);
      b.ring(0.49, 0.06, [0, 1.02, 0], c, { arc: Math.PI, ...metal });
      b.limb([[0, 1.5, 0], [0, 1.2, 0]], [0.019, 0.019], '#887861');
      b.dome([0.26, 0.31, 0.26], [0, 0.88, 0], '#c6c8c7', metal);
      b.ring(0.25, 0.03, [0, 0.88, 0], '#dadbd5', metal, flat);
      b.limb([[0, 0.87, 0], [0, 0.55, 0]], [0.014, 0.014], '#988971');
      b.ball(0.12, [0, 0.52, 0], '#a6a9a7', { scale: [1.3, 0.52, 0.42], ...metal });
      break;
    case 'silver-crane': {
      const silver = dye ?? '#c1c7c5';
      b.cyl(0.36, 0.16, [0, 0.08, 0], '#94795b', { sides: 8, ...metal });
      b.limb([[0, 0.16, 0], [0.035, 0.63, 0]], [0.026, 0.033], '#85715e');
      b.ball(0.31, [0.02, 0.78, 0], silver, { scale: [0.73, 0.7, 1.3], ...metal }, [-0.22, 0, 0]);
      b.limb([[0, 0.8, 0.17], [0, 0.99, 0.28], [0, 1.19, 0.17], [0, 1.32, 0.3]], [0.1, 0.075, 0.047, 0.057], silver, metal);
      b.limb([[0, 1.32, 0.3], [0, 1.29, 0.53]], [0.055, 0.002], '#aa895c');
      break;
    }
    case 'gold-sphere':
      b.cyl(0.36, 0.18, [0, 0.09, 0], '#8f6847', { top: 0.25, ...metal });
      b.cyl(0.12, 0.21, [0, 0.24, 0], c, metal);
      for (const angle of [[0, 0, 0],[0.8, 0.5, 0.7],[Math.PI / 2, 0.3, -0.2]] as V3[]) b.ring(0.47, 0.034, [0, 0.78, 0], c, metal, angle);
      b.ball(0.12, [0, 0.78, 0], '#f3c77a', metal);
      break;
    case 'lotus-basin':
      basin(b, c, true);
      lilies(b, [0, 0], 0.34, [0.37, 0.36], 5, ['#fff5da']);
      break;
    case 'rain-spout':
      b.group([0.26, 0, 0], () => basin(b, c, true), 0, 0.73);
      b.cyl(0.095, 1.04, [-0.36, 0.52, 0], dye ?? '#74a6a0', glaze);
      b.limb([[-0.36, 0.93, 0], [0.18, 0.82, 0]], [0.085, 0.075], dye ?? '#81b1a6', glaze);
      b.limb([[0.18, 0.82, 0],[0.24, 0.7, 0],[0.28, 0.24, 0]], [0.038, 0.028, 0.021], '#b9e5de', glaze);
      break;
    case 'koi-fountain':
      basin(b, c, true);
      b.limb([[0.24, 0.33, 0], [0.34, 0.64, 0], [0.21, 0.97, 0], [0.02, 1.08, 0], [-0.17, 1, 0]], [0.06, 0.14, 0.16, 0.14, 0.085], c, glaze);
      b.ball(0.17, [0.37, 1, 0], toned(c, 1.34), { scale: [0.47, 1.22, 0.5] }, [0, 0, 0.48]);
      for (const z of [-0.106, 0.106]) b.ball(0.028, [-0.04, 1.065, z], '#e7d19b');
      b.limb([[-0.17, 1, 0],[-0.28, 0.95, 0],[-0.38, 0.7, 0],[-0.4, 0.33, 0]], [0.029, 0.026, 0.023, 0.02], '#b9e5de', glaze);
      break;
  }
  return b.finish();
}

export function ElementOrnament({ piece, color }: { piece: ElementPiece; color?: string }) {
  const build = useMemo(() => buildOrnament(piece, color), [piece, color]);
  return <Built build={build} origin={base} />;
}
