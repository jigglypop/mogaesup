import type { Element } from '../elements';
import type { YardSymbol } from '../profile';
import { jar } from './arch';
import type { Builder, Finish, V3 } from './build';
import { bamboo, bush, flowerBed, pine, rock, tree, type Palette } from './plants';

// What stands in a garden beside the house: the day master's symbol (one of ten) and a keepsake of the chart's second
// element (one of five). Each is built about its own foot, as a thing a garden could really hold.

const QUARTER = Math.PI / 2;
const TAU = Math.PI * 2;
const STONE: Finish = { surface: 'stone', rough: 0.9 };
const WOOD: Finish = { surface: 'wood', rough: 0.8 };
const IRON: Finish = { metal: 0.75, rough: 0.48 };
const BRONZE: Finish = { metal: 0.9, rough: 0.32 };
const GREENS: Palette = ['#4f8a45', '#5f9a50', '#447a3e', '#6ba55a'];

const SYMBOLS: Record<YardSymbol, (b: Builder) => void> = {
  /** 甲: a great tree, taller than the house, a seat of stone about its foot. */
  tree: (b) => {
    tree(b, [0, 0, 0], { height: 5.7, spread: 3.7, bark: '#5a4636', leaves: ['#3f7a3a', '#4f8f45', '#356a33', '#62a052'], lobes: 6, girth: 0.3, lean: 0.05, fork: 0.42 });
    b.cyl(0.66, 0.15, [0, 0.075, 0], '#cfc6b6', { ...STONE, sides: 28 });
    rock(b, [0.85, 0, 0.5], 0.3, '#8f8b7e');
    rock(b, [-0.8, 0, 0.55], 0.22, '#9c978a');
  },
  /** 乙: an arch the roses have climbed, wisteria hanging in it. */
  trellis: (b) => {
    const white = '#efe6d6';
    for (const z of [-0.2, 0.2]) {
      for (const x of [-0.55, 0.55]) b.box([0.055, 1.25, 0.055], [x, 0.625, z], white, WOOD);
      b.ring(0.55, 0.028, [0, 1.25, z], white, { arc: Math.PI, rough: 0.7 });
    }
    for (let rung = 0; rung < 9; rung++) {
      const angle = (rung / 8) * Math.PI;
      b.box([0.03, 0.03, 0.44], [-Math.cos(angle) * 0.55, 1.25 + Math.sin(angle) * 0.55, 0], white, WOOD);
    }
    for (const x of [-0.55, 0.55]) for (const y of [0.3, 0.62, 0.94]) b.box([0.03, 0.03, 0.44], [x, y, 0], white, WOOD);
    const pinks: Palette = ['#f7a8c4', '#fbd0de', '#e87aa4', '#fff0f4'];
    for (let spray = 0; spray < 210; spray++) {
      const along = b.random() * (2.5 + Math.PI * 0.55);
      let x: number;
      let y: number;
      if (along < 1.25) [x, y] = [-0.55, along];
      else if (along < 2.5) [x, y] = [0.55, along - 1.25];
      else [x, y] = [-Math.cos((along - 2.5) / 0.55) * 0.55, 1.25 + Math.sin((along - 2.5) / 0.55) * 0.55];
      const at: V3 = [x + b.between(-0.1, 0.1), y + b.between(-0.05, 0.08), b.between(-0.27, 0.27)];
      b.sprig('leaf', at, b.between(0.17, 0.26), b.pick(GREENS), [x * 0.8, 0.6, at[2] * 2], b.between(0, TAU), [x, 0.5, at[2] * 2], b.between(0.78, 1.05));
      if (spray % 3 === 0) b.sprig('bloom', [at[0] * 1.06, at[1] + 0.03, at[2] * 1.15], b.between(0.09, 0.14), b.pick(pinks), [x * 0.6, 0.6, at[2] * 3], b.between(0, TAU));
    }
    for (let hung = 0; hung < 11; hung++) {
      const angle = b.between(0.25, Math.PI - 0.25);
      const x = -Math.cos(angle) * 0.5;
      const top = 1.25 + Math.sin(angle) * 0.5;
      const z = b.between(-0.18, 0.18);
      for (let bead = 0; bead < 5; bead++) b.sprig('puff', [x, top - 0.06 - bead * 0.055, z], 0.075 - bead * 0.009, b.pick(['#b79cf0', '#c9b2f7', '#9f84e0']));
    }
    flowerBed(b, [0, 0.55], [0.75, 0.3], 16, pinks);
  },
  /** 丙: a sundial, sunflowers turned to the light, and a gilded sun on its pole. */
  sun: (b) => {
    b.cyl(0.27, 0.06, [0, 0.03, 0], '#cfc6b6', { ...STONE, sides: 20 });
    b.cyl(0.11, 0.5, [0, 0.31, 0], '#d6cdbd', { ...STONE, top: 0.09 });
    b.cyl(0.3, 0.05, [0, 0.585, 0], '#e3dccd', { ...STONE, sides: 24 });
    b.box([0.012, 0.2, 0.3], [0, 0.68, 0], '#c79a4a', BRONZE, [0.62, 0, 0]);
    for (let stalk = 0; stalk < 7; stalk++) {
      const x = -0.9 + stalk * 0.3 + b.between(-0.06, 0.06);
      const z = -0.6 - b.between(0, 0.35);
      const tall = b.between(1.1, 1.75);
      b.limb([[x, 0, z], [x + 0.02, tall * 0.6, z + 0.01], [x - 0.03, tall, z + 0.08]], [0.022, 0.018, 0.014], '#5f8a3c', { rough: 0.8, sides: 6 });
      for (let pair = 0; pair < 5; pair++) {
        const turn = pair * 2.4;
        b.sprig('leaf', [x + Math.cos(turn) * 0.08, tall * (0.2 + pair * 0.14), z + Math.sin(turn) * 0.08], 0.36, b.pick(GREENS), [Math.cos(turn), 0.25, Math.sin(turn)], turn, [0, 1, 0], 0.92);
      }
      const face: V3 = [-0.42, 0.5, 0.76];
      b.sprig('bloom', [x - 0.03, tall, z + 0.1], b.between(0.36, 0.46), b.pick(['#ffc21f', '#ffb30f', '#ffd040']), face, stalk);
      b.sprig('puff', [x - 0.045, tall + 0.014, z + 0.125], [0.16, 0.05, 0.16], '#4f321a', face);
    }
    const gold: Finish = { metal: 0.95, rough: 0.24, glow: '#ffcf70', power: 0.9 };
    b.cyl(0.018, 2.2, [0.85, 1.1, -0.15], '#7d6032', { ...BRONZE, sides: 8 });
    b.cyl(0.2, 0.035, [0.85, 2.36, -0.15], '#f2c55c', { ...gold, sides: 24 }, [QUARTER, 0, 0]);
    for (let ray = 0; ray < 12; ray++) {
      const angle = (ray / 12) * TAU;
      b.box([0.035, ray % 2 ? 0.1 : 0.15, 0.02], [0.85 + Math.cos(angle) * 0.29, 2.36 + Math.sin(angle) * 0.29, -0.15], '#f2c55c', gold, [0, 0, angle - QUARTER]);
    }
    b.lamp([0.85, 2.36, 0.1], '#ffd27a', 1.1, 3.2);
  },
  /** 丁: candles burning on a stone table. */
  candle: (b) => {
    b.cyl(0.34, 0.09, [0, 0.045, 0], '#cfc6b6', { ...STONE, sides: 20 });
    b.cyl(0.13, 0.36, [0, 0.27, 0], '#d6cdbd', { ...STONE, top: 0.11 });
    b.cyl(0.44, 0.07, [0, 0.485, 0], '#e3dccd', { ...STONE, sides: 28 });
    for (const [x, z, tall, wide] of [[0, 0, 0.5, 0.07], [0.21, 0.1, 0.32, 0.06], [-0.2, 0.13, 0.4, 0.055], [-0.08, -0.22, 0.24, 0.06], [0.17, -0.19, 0.18, 0.05]] as const) {
      b.cyl(wide, tall, [x, 0.52 + tall / 2, z], '#f6ead2', { rough: 0.45, sides: 14, glow: '#ffb35a', power: 0.22 });
      b.sprig('puff', [x + wide * 0.8, 0.52 + tall * 0.7, z], [0.03, 0.07, 0.03], '#f6ead2');
      b.life({ kind: 'fire', at: [x, 0.52 + tall - 0.02, z], scale: 0.17 });
    }
    b.lamp([0, 1.15, 0.1], '#ffb060', 2.3, 5, true);
    b.ring(0.47, 0.012, [0, 0.52, 0], '#c79a4a', { ...BRONZE }, [QUARTER, 0, 0]);
  },
  /** 戊: a 석가산, rocks set up as a mountain, a pine on its shoulder and mist about its top. */
  mountain: (b) => {
    const greys: Palette = ['#a9a399', '#b7b1a6', '#989288'];
    for (const [x, y, z, wide, tall, deep] of [[0, 0.7, -0.1, 1.2, 2.0, 1.1], [0.62, 0.45, 0.3, 0.9, 1.3, 0.85], [-0.6, 0.36, 0.4, 0.8, 1.05, 0.8], [0.1, 0.2, 0.85, 0.7, 0.55, 0.6], [-0.95, 0.15, -0.2, 0.55, 0.45, 0.5]] as const) {
      b.sprig('rock', [x, y, z], [wide, tall, deep], b.pick(greys), [b.between(-0.1, 0.1), 1, b.between(-0.1, 0.1)], b.between(0, TAU), [0, 1, 0], b.between(0.85, 1.05));
    }
    for (let moss = 0; moss < 46; moss++) {
      const angle = b.between(0, TAU);
      const away = b.between(0.1, 0.75);
      b.sprig('leaf', [Math.cos(angle) * away, 0.55 + b.between(0, 0.85) * (1 - away), Math.sin(angle) * away + 0.2], 0.15, b.pick(['#5a8a45', '#6b9a50', '#4c7a3c']), [Math.cos(angle) * 0.4, 1, Math.sin(angle) * 0.4], b.between(0, TAU), [0, 1, 0], 0.9);
    }
    pine(b, [0.68, 0.95, 0.22], { height: 1.35, spread: 1.05, needles: ['#3f6b4a', '#4a7a55', '#335c40'] });
    pine(b, [-0.75, 0.5, 0.45], { height: 0.9, spread: 0.7, needles: ['#3f6b4a', '#4a7a55', '#335c40'] });
    b.life({ kind: 'mist', at: [0, 1.25, 0.2], reach: 1.1 });
  },
  /** 己: a kitchen garden in rows, and its scarecrow. */
  field: (b) => {
    for (const [row, z] of [-0.46, 0, 0.46].entries()) {
      b.box([1.75, 0.13, 0.33], [0, 0.045, z], '#5f4330', { surface: 'soil', rough: 1 });
      for (let plant = 0; plant < 6; plant++) {
        const x = -0.72 + plant * 0.29;
        if (row === 0) {
          b.sprig('puff', [x, 0.2, z], [0.2, 0.15, 0.2], '#b5d68a');
          for (let leaf = 0; leaf < 3; leaf++) b.sprig('leaf', [x, 0.14, z], 0.3, b.pick(['#8fbf6a', '#7aae5c']), [Math.cos(leaf * 2.1) * 0.6, 0.6, Math.sin(leaf * 2.1) * 0.6], leaf * 2, [0, 1, 0]);
        } else if (row === 1) {
          b.sprig('leaf', [x, 0.22, z], [0.26, 0.34, 0.26], b.pick(GREENS), [0, 1, 0], plant, [0, 1, 0]);
          for (let pod = 0; pod < 3; pod++) b.sprig('puff', [x + b.between(-0.07, 0.07), 0.2 + b.between(0, 0.1), z + b.between(-0.07, 0.07)], [0.035, 0.1, 0.035], '#d6362a');
        } else {
          for (let blade = 0; blade < 4; blade++) b.sprig('frond', [x + b.between(-0.04, 0.04), 0.1, z + b.between(-0.04, 0.04)], [0.5, b.between(0.34, 0.5), 0.5], b.pick(['#7fb35a', '#93c26a']), [b.between(-0.2, 0.2), 1, b.between(-0.2, 0.2)], b.between(0, TAU));
        }
      }
    }
    b.group(
      [0.15, 0, -0.9],
      () => {
        b.box([0.05, 1.3, 0.05], [0, 0.65, 0], '#7a5a42', WOOD);
        b.box([0.95, 0.045, 0.045], [0, 0.98, 0], '#7a5a42', WOOD);
        b.box([0.42, 0.42, 0.13], [0, 0.86, 0], '#b8452f', { rough: 0.95 });
        for (const side of [-1, 1]) {
          b.box([0.26, 0.11, 0.12], [side * 0.33, 0.98, 0], '#b8452f', { rough: 0.95 });
          for (let straw = 0; straw < 4; straw++) b.sprig('frond', [side * 0.47, 0.98, 0], 0.2, '#dcbc6a', [side, b.between(-0.5, 0.3), b.between(-0.4, 0.4)], straw);
        }
        b.ball(0.14, [0, 1.22, 0], '#e3d2ae', { rough: 1, detail: 12 });
        b.cone(0.31, 0.17, [0, 1.38, 0], '#d2b060', { surface: 'thatch', rough: 1, sides: 16 });
        b.cyl(0.11, 0.08, [0, 1.37, 0], '#c4a252', { surface: 'thatch', rough: 1 });
      },
      Math.PI / 4,
    );
  },
  /** 庚: an anvil on its stump, the hammer by it, the forge's coals alight. */
  anvil: (b) => {
    const iron = '#4a4d55';
    b.cyl(0.3, 0.34, [0, 0.17, 0], '#8b6444', { surface: 'bark', sides: 14 });
    b.cyl(0.275, 0.012, [0, 0.345, 0], '#d9bd92', { surface: 'wood', sides: 14 });
    b.box([0.36, 0.09, 0.24], [0, 0.395, 0], iron, IRON);
    b.box([0.18, 0.13, 0.16], [0, 0.505, 0], iron, IRON);
    b.box([0.5, 0.12, 0.22], [-0.02, 0.63, 0], '#5a5e68', { metal: 0.85, rough: 0.34 });
    b.cone(0.085, 0.28, [0.36, 0.635, 0], '#5a5e68', { metal: 0.85, rough: 0.34, sides: 12 }, [0, 0, -QUARTER]);
    b.box([0.035, 0.5, 0.035], [-0.45, 0.24, 0.22], '#7a5a42', WOOD, [0, 0, 0.4]);
    b.box([0.17, 0.1, 0.1], [-0.55, 0.47, 0.22], iron, IRON, [0, 0, 0.4]);
    b.ring(0.08, 0.016, [0.4, 0.02, 0.42], '#6b6f7a', { ...IRON, arc: Math.PI * 1.25 }, [QUARTER, 0, 0.4]);
    for (let stone = 0; stone < 8; stone++) {
      const angle = (stone / 8) * TAU;
      rock(b, [-0.75 + Math.cos(angle) * 0.24, 0, -0.4 + Math.sin(angle) * 0.24], 0.16, b.pick(['#7d7870', '#8f8a80']), 0.8);
    }
    for (let coal = 0; coal < 5; coal++) b.ball(0.05, [-0.75 + b.between(-0.1, 0.1), 0.1, -0.4 + b.between(-0.1, 0.1)], '#ff8a3d', { glow: '#ff5a1f', power: 3.2, detail: 6 });
    b.life({ kind: 'fire', at: [-0.75, 0.12, -0.4], scale: 0.34 });
    b.lamp([-0.75, 0.4, -0.4], '#ff8a3d', 1.7, 3.5, true);
    b.cyl(0.14, 0.24, [0.55, 0.12, -0.35], '#8b6444', { ...WOOD, top: 0.16, sides: 14 });
    b.cyl(0.145, 0.01, [0.55, 0.22, -0.35], '#2f4a66', { rough: 0.05, metal: 0.85, sides: 14 });
  },
  /** 辛: crystals standing out of their rock, on a plinth. */
  gem: (b) => {
    b.cyl(0.4, 0.1, [0, 0.05, 0], '#cfc6b6', { ...STONE, sides: 8 });
    b.cyl(0.26, 0.42, [0, 0.31, 0], '#d6cdbd', { ...STONE, sides: 8 });
    b.cyl(0.36, 0.07, [0, 0.555, 0], '#e3dccd', { ...STONE, sides: 8 });
    b.sprig('rock', [0, 0.66, 0], [0.5, 0.22, 0.45], '#5f5a66', [0, 1, 0], 0.4);
    const clear: Finish = { rough: 0.07, metal: 0.18, glow: '#b9c4ff', power: 0.6 };
    for (const [x, z, tall, wide, lean, color] of [
      [0, 0, 0.62, 0.085, 0, '#dfe6ff'],
      [0.14, 0.06, 0.4, 0.065, -0.4, '#c9d3ff'],
      [-0.15, -0.02, 0.36, 0.06, 0.42, '#efe6ff'],
      [0.02, 0.15, 0.26, 0.05, -0.15, '#ffffff'],
      [-0.07, -0.14, 0.3, 0.05, 0.2, '#d6ccff'],
      [0.12, -0.12, 0.22, 0.045, -0.5, '#dfe6ff'],
    ] as const) {
      b.group(
        [x, 0.68, z],
        () => {
          b.cyl(wide, tall, [0, tall / 2, 0], color, { ...clear, sides: 6 });
          b.cone(wide, wide * 1.7, [0, tall + wide * 0.85, 0], color, { ...clear, sides: 6 });
        },
        [z * 2, 0, lean],
      );
    }
    b.life({ kind: 'fireflies', at: [0, 1.0, 0], reach: 0.35, count: 4 });
    b.lamp([0, 1.15, 0.1], '#cdd6ff', 1.2, 3);
  },
  /** 壬: a lighthouse on its rocks, its lamp turning. */
  lighthouse: (b) => {
    for (const [x, z, size] of [[0, 0, 1.3], [0.55, 0.3, 0.6], [-0.5, 0.35, 0.55], [0.2, -0.55, 0.5], [-0.3, -0.45, 0.45]] as const) rock(b, [x, 0, z], size, b.pick(['#7d7a74', '#8c8982', '#6c6a66']), 0.5);
    const radiusAt = (y: number) => 0.34 - ((y - 0.35) / 1.9) * 0.1;
    b.cyl(0.34, 1.9, [0, 1.3, 0], '#f4f0e6', { top: 0.24, surface: 'plaster', sides: 22 });
    for (const y of [0.85, 1.55]) b.cyl(radiusAt(y - 0.15) + 0.004, 0.3, [0, y, 0], '#c23b2f', { top: radiusAt(y + 0.15) + 0.004, surface: 'plaster', sides: 22 });
    b.box([0.16, 0.3, 0.04], [0, 0.52, 0.335], '#2f5f96', WOOD);
    b.cyl(0.37, 0.05, [0, 2.275, 0], '#3a3d45', { ...IRON, sides: 22 });
    b.ring(0.36, 0.01, [0, 2.44, 0], '#3a3d45', IRON, [QUARTER, 0, 0]);
    for (let post = 0; post < 10; post++) b.cyl(0.008, 0.15, [Math.cos((post / 10) * TAU) * 0.36, 2.37, Math.sin((post / 10) * TAU) * 0.36], '#3a3d45', { ...IRON, sides: 4 });
    b.cyl(0.19, 0.3, [0, 2.45, 0], '#fff3c4', { sides: 14, glow: '#ffd98a', power: 5 });
    b.cone(0.27, 0.24, [0, 2.72, 0], '#c23b2f', { sides: 16, rough: 0.6 });
    b.ball(0.035, [0, 2.86, 0], '#3a3d45', { ...IRON, detail: 8 });
    b.life({ kind: 'beam', at: [0, 2.45, 0] });
    b.lamp([0, 2.5, 0], '#ffe2a0', 2.6, 6);
  },
  /** 癸: rain caught: a chain from its bracket running into a stone basin, mist over wet stones. */
  rain: (b) => {
    b.cyl(0.42, 0.3, [0, 0.15, 0], '#a9a59c', { ...STONE, top: 0.5, sides: 22 });
    b.cyl(0.43, 0.02, [0, 0.29, 0], '#2a4563', { rough: 0.04, metal: 0.9, sides: 26 });
    b.box([0.07, 1.75, 0.07], [-0.62, 0.875, -0.1], '#4a372b', WOOD);
    b.box([0.85, 0.06, 0.06], [-0.24, 1.72, -0.1], '#4a372b', WOOD);
    b.box([0.4, 0.045, 0.045], [-0.47, 1.56, -0.1], '#4a372b', WOOD, [0, 0, 0.75]);
    for (let cup = 0; cup < 9; cup++) b.cone(0.04, 0.07, [0.12, 1.62 - cup * 0.145, -0.1], '#b98a45', { ...BRONZE, sides: 10 }, [Math.PI, 0, 0]);
    b.limb([[0.12, 1.7, -0.1], [0.12, 0.34, -0.1]], [0.004, 0.004], '#8a6a3a', { ...BRONZE, sides: 4, shadowless: true });
    b.life({ kind: 'ripples', at: [0.12, 0.3, -0.05], reach: 0.3 });
    b.life({ kind: 'mist', at: [0, 0.45, 0.1], reach: 1.0 });
    for (const [x, z, size] of [[0.6, 0.35, 0.3], [-0.45, 0.5, 0.24], [0.1, 0.62, 0.2], [0.7, -0.3, 0.22]] as const) rock(b, [x, 0, z], size, b.pick(['#5f646b', '#6d7279', '#555a61']), 0.6);
    bush(b, [0.85, 0, 0.05], 0.36, GREENS, { colors: ['#7f9cf0', '#9aa8f5', '#b79cf0', '#6f8ae0'], count: 9, kind: 'puff', size: 0.16 });
    for (let fern = 0; fern < 9; fern++) b.sprig('frond', [-0.5, 0.02, 0.55], b.between(0.36, 0.5), b.pick(GREENS), [Math.cos(fern * 0.7) * 0.7, 0.6, Math.sin(fern * 0.7) * 0.7], fern, [0, 1, 0]);
    b.sprig('puff', [0.3, 0.33, 0.28], [0.11, 0.07, 0.13], '#5f9a45');
  },
};

/** The day master's symbol, standing at `at`. */
export function emblem(b: Builder, symbol: YardSymbol, at: V3): void {
  b.group(at, () => SYMBOLS[symbol](b));
}

const KEEPSAKES: Record<Element, (b: Builder) => void> = {
  /** 목: bamboo in a glazed pot. */
  wood: (b) => {
    b.cyl(0.2, 0.34, [0, 0.17, 0], '#e9eef5', { top: 0.27, rough: 0.25, sides: 18 });
    b.cyl(0.28, 0.04, [0, 0.34, 0], '#3f6fb0', { rough: 0.25, sides: 18 });
    b.cyl(0.25, 0.02, [0, 0.345, 0], '#3d2c22', { rough: 1, sides: 14 });
    bamboo(b, [0, 0.34, 0], { canes: 5, height: 1.75, reach: 0.11 });
  },
  /** 화: a 화로, its coals alight. */
  fire: (b) => {
    for (const turn of [0, 2.1, 4.2]) b.box([0.04, 0.3, 0.04], [Math.cos(turn) * 0.2, 0.14, Math.sin(turn) * 0.2], '#34363d', IRON, [Math.sin(turn) * 0.25, 0, -Math.cos(turn) * 0.25]);
    b.cyl(0.2, 0.2, [0, 0.36, 0], '#3f424a', { ...IRON, top: 0.31, sides: 18 });
    b.ring(0.31, 0.016, [0, 0.46, 0], '#55585f', IRON, [QUARTER, 0, 0]);
    for (let coal = 0; coal < 7; coal++) b.ball(0.055, [b.between(-0.15, 0.15), 0.45, b.between(-0.15, 0.15)], '#ff8a3d', { glow: '#ff5a1f', power: 3.4, detail: 6 });
    b.life({ kind: 'fire', at: [0, 0.44, 0], scale: 0.36 });
    b.lamp([0, 0.75, 0], '#ff9050', 1.6, 3.6, true);
  },
  /** 토: 옹기 by a mossy stone. */
  earth: (b) => {
    jar(b, [-0.18, 0, -0.05], 1.25);
    jar(b, [0.3, 0, 0.18], 0.85, '#6b4a35');
    jar(b, [0.02, 0, 0.42], 0.6, '#4f3527');
    rock(b, [0.28, 0, -0.36], 0.34, '#a59c8a');
    for (let moss = 0; moss < 6; moss++) b.sprig('leaf', [0.28 + b.between(-0.1, 0.1), 0.2, -0.36 + b.between(-0.1, 0.1)], 0.14, '#5a8a45', [0, 1, 0], moss);
  },
  /** 금: a bronze 풍경 on its post. */
  metal: (b) => {
    b.cyl(0.16, 0.1, [0, 0.05, 0], '#cfc6b6', { ...STONE, top: 0.12, sides: 12 });
    b.cyl(0.022, 1.5, [0, 0.8, 0], '#34363d', { ...IRON, sides: 8 });
    b.limb([[0, 1.5, 0], [0.12, 1.6, 0], [0.32, 1.58, 0], [0.4, 1.48, 0]], [0.016, 0.014, 0.012, 0.01], '#34363d', { ...IRON, sides: 6 });
    b.cyl(0.004, 0.12, [0.4, 1.42, 0], '#55585f', { sides: 4 });
    b.cyl(0.085, 0.13, [0.4, 1.3, 0], '#c79a4a', { ...BRONZE, top: 0.045, sides: 16 });
    b.cyl(0.004, 0.2, [0.4, 1.15, 0], '#55585f', { sides: 4 });
    b.box([0.09, 0.13, 0.008], [0.4, 1.0, 0], '#c9d3e6', { metal: 0.8, rough: 0.3 }, [0, 0.5, 0]);
    rock(b, [-0.25, 0, 0.2], 0.24, '#b9b6ad');
  },
  /** 수: a 돌확, a lily afloat in it and a ladle across its rim. */
  water: (b) => {
    b.cyl(0.3, 0.26, [0, 0.13, 0], '#a9a59c', { ...STONE, top: 0.38, sides: 20 });
    b.cyl(0.32, 0.02, [0, 0.25, 0], '#2a4563', { rough: 0.04, metal: 0.9, sides: 22 });
    b.sprig('pad', [-0.08, 0.265, 0.06], 0.2, '#4f8f4a');
    b.sprig('pad', [0.12, 0.265, -0.1], 0.14, '#5b9c52', [0, 1, 0], 2);
    b.sprig('bloom', [-0.06, 0.3, 0.05], 0.13, '#fbd0de');
    b.cyl(0.012, 0.6, [0.08, 0.3, 0.12], '#a98458', { ...WOOD, sides: 6 }, [0.2, 0.6, QUARTER - 0.12]);
    b.cyl(0.05, 0.06, [0.32, 0.31, -0.04], '#a98458', { ...WOOD, sides: 10 });
    b.life({ kind: 'ripples', at: [0.02, 0.262, -0.02], reach: 0.22 });
    rock(b, [0.42, 0, 0.3], 0.22, '#7c858b');
  },
};

/** The second element's keepsake, standing at `at`. */
export function keepsake(b: Builder, element: Element, at: V3): void {
  b.group(at, () => KEEPSAKES[element](b));
}
