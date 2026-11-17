import { BRANCHES, STEMS } from '../elements';
import type { Builder, V3 } from './build';

// The four pillars of a chart as stone figures in a row, one for each 간지: the branch (지지) is the animal carved on
// top, of the twelve; the stem (천간) is the pedestal it sits on, square for a yang stem and round for a yin one, its
// top and the cloth tied about the animal's neck in the stem's element's colour (오방색). Ten stems and twelve branches
// make the sixty 갑자, each its own figure. Drawn about their own foot, facing +z, the year on the right (as a chart is
// read) and the hour on the left.

const STONE = '#c6beaf';
const DARK = '#9a9284';
const EYE = '#2b2724';
const FINISH = { surface: 'stone' as const, rough: 0.9 };

/** 오방색: wood 청, fire 적, earth 황, metal 백, water 흑. */
const STEM_COLOUR = ['#2f7d5a', '#2f7d5a', '#c8372d', '#c8372d', '#d9a62e', '#d9a62e', '#efeae0', '#efeae0', '#2b2f3a', '#2b2f3a'] as const;

/** Where a figure's neck is (for its cloth), and how wide. */
type Neck = { at: V3; radius: number };

/** Two eyes either side of `at`, `apart` across, looking +z. */
function eyes(b: Builder, at: V3, apart: number, size = 0.022): void {
  for (const side of [-1, 1]) b.ball(size, [at[0] + side * apart, at[1], at[2]], EYE, { rough: 0.4, detail: 8 });
}

const ANIMALS: Record<string, (b: Builder) => Neck> = {
  // 子 쥐: round and small, big round ears, a pointed snout and a long thin tail.
  子: (b) => {
    b.ball(0.2, [0, 0.2, 0], STONE, { ...FINISH, scale: [1, 0.9, 1.25] });
    b.ball(0.13, [0, 0.38, 0.2], STONE, { ...FINISH, scale: [1, 0.92, 1.15] });
    b.cone(0.06, 0.13, [0, 0.36, 0.35], STONE, { ...FINISH, sides: 10 }, [Math.PI / 2, 0, 0]);
    b.ball(0.02, [0, 0.36, 0.42], EYE, { detail: 8 });
    for (const side of [-1, 1]) b.ball(0.075, [side * 0.1, 0.5, 0.16], STONE, { ...FINISH, scale: [1, 1, 0.35] });
    eyes(b, [0, 0.42, 0.31], 0.055);
    b.limb([[0, 0.08, -0.23], [0.14, 0.04, -0.4], [0.3, 0.08, -0.46], [0.38, 0.16, -0.4]], [0.022, 0.016, 0.011, 0.007], DARK, { ...FINISH, sides: 6 });
    return { at: [0, 0.3, 0.12], radius: 0.12 };
  },
  // 丑 소: broad and lying down, a wide muzzle, horns curving out and up.
  丑: (b) => {
    b.ball(0.24, [0, 0.22, -0.04], STONE, { ...FINISH, scale: [1.12, 0.82, 1.4] });
    b.ball(0.15, [0, 0.36, 0.3], STONE, { ...FINISH, scale: [1.05, 1, 1.05] });
    b.ball(0.1, [0, 0.3, 0.43], DARK, { ...FINISH, scale: [1.3, 0.8, 0.75] });
    for (const side of [-1, 1]) {
      b.limb([[side * 0.09, 0.46, 0.3], [side * 0.22, 0.5, 0.29], [side * 0.27, 0.6, 0.27]], [0.032, 0.024, 0.012], '#e8e1d2', { ...FINISH, sides: 7 });
      b.ball(0.06, [side * 0.18, 0.4, 0.27], STONE, { ...FINISH, scale: [1.3, 0.6, 0.6] });
    }
    eyes(b, [0, 0.4, 0.43], 0.075);
    return { at: [0, 0.3, 0.17], radius: 0.15 };
  },
  // 寅 호랑이: sitting up, ears round, stripes down its back, its tail about its feet.
  寅: (b) => {
    b.ball(0.2, [0, 0.26, -0.05], STONE, { ...FINISH, scale: [1, 1.25, 1.05] });
    b.ball(0.15, [0, 0.53, 0.06], STONE, FINISH);
    b.ball(0.075, [0, 0.49, 0.19], STONE, { ...FINISH, scale: [1.25, 0.8, 1] });
    for (const side of [-1, 1]) {
      b.cone(0.05, 0.07, [side * 0.1, 0.66, 0.04], STONE, { ...FINISH, sides: 8 });
      b.cyl(0.045, 0.3, [side * 0.08, 0.15, 0.12], STONE, { ...FINISH, sides: 8 });
      for (const y of [0.22, 0.32, 0.42]) b.box([0.02, 0.05, 0.16], [side * 0.19, y, -0.06], '#5a5249', FINISH, [0, 0, side * 0.3]);
    }
    eyes(b, [0, 0.56, 0.18], 0.06);
    b.limb([[0, 0.08, -0.24], [0.2, 0.05, -0.2], [0.27, 0.06, 0.02], [0.2, 0.08, 0.14]], [0.035, 0.03, 0.026, 0.02], STONE, { ...FINISH, sides: 7 });
    return { at: [0, 0.4, 0.04], radius: 0.13 };
  },
  // 卯 토끼: round, its long ears up, a puff of a tail.
  卯: (b) => {
    b.ball(0.19, [0, 0.21, -0.03], STONE, { ...FINISH, scale: [1, 1.08, 1.1] });
    b.ball(0.12, [0, 0.43, 0.08], STONE, FINISH);
    for (const side of [-1, 1]) b.ball(0.06, [side * 0.05, 0.64, 0.02], STONE, { ...FINISH, scale: [0.7, 2.6, 0.4] }, [0, 0, side * -0.12]);
    b.ball(0.06, [0, 0.14, -0.23], '#ebe5d8', FINISH);
    for (const side of [-1, 1]) b.ball(0.045, [side * 0.07, 0.06, 0.14], STONE, { ...FINISH, scale: [1, 0.7, 1.4] });
    eyes(b, [0, 0.46, 0.18], 0.05);
    return { at: [0, 0.33, 0.06], radius: 0.1 };
  },
  // 辰 용: coiled about itself and rearing, horns swept back, a beard.
  辰: (b) => {
    const coil: V3[] = Array.from({ length: 22 }, (_, index) => {
      const turn = (index / 21) * Math.PI * 3.2;
      const reach = 0.2 - index * 0.004;
      return [Math.cos(turn) * reach, 0.07 + index * 0.017, Math.sin(turn) * reach - 0.02];
    });
    coil.push([0, 0.52, 0.06], [0, 0.6, 0.1]);
    b.limb(coil, [0.06, 0.068, 0.07, 0.068, 0.064, 0.06, 0.056, 0.052, 0.05, 0.048, 0.046, 0.045, 0.044, 0.043, 0.042, 0.041, 0.04, 0.04, 0.04, 0.04, 0.04, 0.04, 0.045, 0.05], STONE, { ...FINISH, sides: 9 });
    b.ball(0.09, [0, 0.64, 0.14], STONE, { ...FINISH, scale: [0.95, 0.8, 1.5] });
    for (const side of [-1, 1]) {
      b.limb([[side * 0.04, 0.7, 0.1], [side * 0.08, 0.78, 0.0], [side * 0.1, 0.82, -0.1]], [0.018, 0.012, 0.006], '#e8e1d2', { ...FINISH, sides: 6 });
      b.limb([[side * 0.04, 0.6, 0.26], [side * 0.12, 0.58, 0.32], [side * 0.18, 0.62, 0.34]], [0.008, 0.006, 0.004], DARK, { ...FINISH, sides: 4 });
    }
    for (let spine = 0; spine < 5; spine++) {
      const [x, y, z] = coil[6 + spine * 3]!;
      b.cone(0.03, 0.08, [x * 1.25, y + 0.06, z * 1.25], DARK, { ...FINISH, sides: 5 });
    }
    eyes(b, [0, 0.68, 0.22], 0.05);
    return { at: [0, 0.5, 0.06], radius: 0.07 };
  },
  // 巳 뱀: coiled low, its head raised from the coil, its tongue out.
  巳: (b) => {
    const coil: V3[] = Array.from({ length: 26 }, (_, index) => {
      const turn = (index / 25) * Math.PI * 4.4;
      const reach = 0.22 - index * 0.0055;
      return [Math.cos(turn) * reach, 0.05 + index * 0.0055, Math.sin(turn) * reach];
    });
    coil.push([0, 0.28, 0.06], [0, 0.4, 0.1]);
    b.limb(coil, [0.05, 0.055, 0.055, 0.052, 0.05, 0.048, 0.046, 0.044, 0.042, 0.04, 0.04, 0.04, 0.04, 0.038, 0.038, 0.037, 0.036, 0.036, 0.035, 0.035, 0.035, 0.034, 0.034, 0.034, 0.034, 0.034, 0.035, 0.036], STONE, { ...FINISH, sides: 8 });
    b.ball(0.07, [0, 0.43, 0.15], STONE, { ...FINISH, scale: [1, 0.65, 1.4] });
    b.limb([[0, 0.42, 0.24], [0, 0.42, 0.29], [0.02, 0.42, 0.32]], [0.006, 0.005, 0.003], '#c8372d', { sides: 4 });
    eyes(b, [0, 0.46, 0.2], 0.04, 0.016);
    return { at: [0, 0.34, 0.1], radius: 0.045 };
  },
  // 午 말: standing, its neck up, a mane and a long tail.
  午: (b) => {
    b.ball(0.18, [0, 0.44, 0], STONE, { ...FINISH, scale: [0.82, 0.82, 1.65] });
    for (const x of [-0.08, 0.08]) for (const z of [-0.18, 0.18]) b.cyl(0.035, 0.38, [x, 0.19, z], STONE, { ...FINISH, top: 0.03, sides: 8 });
    b.limb([[0, 0.5, 0.2], [0, 0.62, 0.28], [0, 0.72, 0.33]], [0.075, 0.06, 0.05], STONE, { ...FINISH, sides: 9 });
    b.ball(0.07, [0, 0.74, 0.42], STONE, { ...FINISH, scale: [0.8, 0.9, 1.8] }, [0.5, 0, 0]);
    b.limb([[0, 0.6, 0.17], [0, 0.72, 0.25], [0, 0.82, 0.31]], [0.022, 0.026, 0.02], DARK, { ...FINISH, sides: 6 });
    for (const side of [-1, 1]) b.cone(0.022, 0.06, [side * 0.035, 0.82, 0.36], STONE, { ...FINISH, sides: 6 });
    b.limb([[0, 0.5, -0.28], [0, 0.4, -0.36], [0, 0.26, -0.38]], [0.03, 0.035, 0.028], DARK, { ...FINISH, sides: 6 });
    eyes(b, [0, 0.79, 0.43], 0.045, 0.016);
    return { at: [0, 0.64, 0.27], radius: 0.07 };
  },
  // 未 양: a cloud of wool, a narrow face, horns curled at its sides.
  未: (b) => {
    for (const [x, y, z, size] of [[0, 0.3, 0, 0.17], [-0.12, 0.28, -0.08, 0.12], [0.12, 0.28, -0.08, 0.12], [-0.11, 0.3, 0.09, 0.12], [0.11, 0.3, 0.09, 0.12], [0, 0.4, -0.06, 0.13], [0, 0.26, -0.18, 0.11]] as const) b.ball(size, [x, y, z], '#ebe5d8', { ...FINISH, scale: [1, 0.9, 1] });
    for (const x of [-0.09, 0.09]) for (const z of [-0.12, 0.12]) b.cyl(0.03, 0.2, [x, 0.1, z], DARK, { ...FINISH, sides: 7 });
    b.ball(0.085, [0, 0.4, 0.24], STONE, { ...FINISH, scale: [0.85, 1, 1.3] });
    for (const side of [-1, 1]) b.ring(0.05, 0.018, [side * 0.09, 0.44, 0.2], DARK, { ...FINISH, arc: Math.PI * 1.6 }, [0, side * Math.PI / 2, 0]);
    eyes(b, [0, 0.44, 0.33], 0.045, 0.016);
    return { at: [0, 0.37, 0.15], radius: 0.09 };
  },
  // 申 원숭이: sitting, its arms about its knees, a pale face, a long tail curling up.
  申: (b) => {
    b.ball(0.16, [0, 0.24, 0], STONE, { ...FINISH, scale: [1, 1.3, 0.9] });
    b.ball(0.12, [0, 0.5, 0.03], STONE, FINISH);
    b.ball(0.08, [0, 0.49, 0.11], '#e6dfd0', { ...FINISH, scale: [1, 1, 0.5] });
    for (const side of [-1, 1]) {
      b.ball(0.045, [side * 0.13, 0.52, 0.02], STONE, { ...FINISH, scale: [0.6, 1, 1] });
      b.limb([[side * 0.13, 0.38, 0.02], [side * 0.15, 0.24, 0.12], [side * 0.06, 0.16, 0.18]], [0.035, 0.03, 0.03], STONE, { ...FINISH, sides: 7 });
      b.ball(0.05, [side * 0.07, 0.07, 0.15], STONE, { ...FINISH, scale: [1, 0.7, 1.3] });
    }
    b.limb([[0, 0.1, -0.15], [0.12, 0.12, -0.3], [0.22, 0.3, -0.3], [0.2, 0.45, -0.2], [0.13, 0.48, -0.16]], [0.024, 0.02, 0.018, 0.016, 0.012], STONE, { ...FINISH, sides: 6 });
    eyes(b, [0, 0.52, 0.15], 0.035, 0.016);
    return { at: [0, 0.4, 0.03], radius: 0.09 };
  },
  // 酉 닭: an egg of a body, a red comb and wattle, its tail feathers fanned up behind.
  酉: (b) => {
    b.ball(0.17, [0, 0.3, 0], STONE, { ...FINISH, scale: [0.9, 1, 1.25] });
    b.ball(0.08, [0, 0.53, 0.12], STONE, FINISH);
    b.cone(0.03, 0.07, [0, 0.52, 0.22], '#d9a62e', { sides: 6, rough: 0.6 }, [Math.PI / 2, 0, 0]);
    for (const [y, z] of [[0.63, 0.1], [0.64, 0.14], [0.62, 0.17]] as const) b.ball(0.025, [0, y, z], '#c8372d', { rough: 0.6, detail: 8 });
    b.ball(0.022, [0, 0.47, 0.19], '#c8372d', { rough: 0.6, detail: 8, scale: [0.8, 1.3, 0.8] });
    for (let feather = 0; feather < 5; feather++) {
      const spread = (feather - 2) * 0.09;
      b.limb([[spread * 0.3, 0.36, -0.16], [spread, 0.5, -0.26], [spread * 1.2, 0.62, -0.24]], [0.03, 0.022, 0.008], DARK, { ...FINISH, sides: 5 });
    }
    for (const side of [-1, 1]) b.cyl(0.015, 0.14, [side * 0.05, 0.08, 0.02], '#d9a62e', { sides: 5 });
    eyes(b, [0, 0.55, 0.18], 0.045, 0.014);
    return { at: [0, 0.45, 0.09], radius: 0.065 };
  },
  // 戌 개: sitting up, ears pricked, a curled tail.
  戌: (b) => {
    b.ball(0.17, [0, 0.24, -0.04], STONE, { ...FINISH, scale: [1, 1.25, 1.1] });
    b.ball(0.12, [0, 0.5, 0.08], STONE, FINISH);
    b.ball(0.07, [0, 0.46, 0.2], STONE, { ...FINISH, scale: [0.9, 0.8, 1.3] });
    b.ball(0.022, [0, 0.47, 0.29], EYE, { detail: 8 });
    for (const side of [-1, 1]) {
      b.cone(0.045, 0.1, [side * 0.075, 0.63, 0.05], STONE, { ...FINISH, sides: 7 });
      b.cyl(0.04, 0.28, [side * 0.07, 0.14, 0.12], STONE, { ...FINISH, sides: 8 });
    }
    b.ring(0.07, 0.025, [0, 0.3, -0.24], STONE, { ...FINISH, arc: Math.PI * 1.5 }, [0, Math.PI / 2, 0]);
    eyes(b, [0, 0.54, 0.18], 0.05, 0.018);
    return { at: [0, 0.4, 0.06], radius: 0.1 };
  },
  // 亥 돼지: round, a flat snout, small ears tipped forward, a curl of a tail.
  亥: (b) => {
    b.ball(0.23, [0, 0.24, 0], STONE, { ...FINISH, scale: [1, 0.85, 1.28] });
    b.ball(0.14, [0, 0.3, 0.27], STONE, FINISH);
    b.cyl(0.06, 0.06, [0, 0.28, 0.41], '#d9b9a8', { ...FINISH, sides: 12 }, [Math.PI / 2, 0, 0]);
    for (const side of [-1, 1]) {
      b.ball(0.012, [side * 0.022, 0.28, 0.445], EYE, { detail: 6 });
      b.cone(0.045, 0.08, [side * 0.09, 0.42, 0.26], STONE, { ...FINISH, sides: 6 }, [0.6, 0, 0]);
    }
    for (const x of [-0.1, 0.1]) for (const z of [-0.14, 0.14]) b.cyl(0.04, 0.12, [x, 0.06, z], STONE, { ...FINISH, sides: 7 });
    b.ring(0.035, 0.012, [0, 0.28, -0.3], DARK, { ...FINISH }, [0, Math.PI / 2, 0]);
    eyes(b, [0, 0.36, 0.38], 0.06, 0.018);
    return { at: [0, 0.3, 0.2], radius: 0.13 };
  },
};

/** One 간지 as a figure, about its foot: the pedestal of its stem, the animal of its branch, the stem's cloth. */
export function ganjiFigure(b: Builder, at: V3, ganji: string, turn = 0): void {
  const [stem = '', branch = ''] = [...ganji];
  const index = STEMS.indexOf(stem);
  const colour = STEM_COLOUR[Math.max(0, index)]!;
  const yang = index % 2 === 0;
  const animal = ANIMALS[branch] ?? ANIMALS['戌']!;
  b.group(
    at,
    () => {
      // The pedestal, square for yang and round for yin, its top in the stem's colour.
      if (yang) {
        b.box([0.6, 0.24, 0.6], [0, 0.12, 0], '#b3ab9b', FINISH);
        b.box([0.64, 0.05, 0.64], [0, 0.265, 0], colour, { rough: 0.7 });
      } else {
        b.cyl(0.32, 0.24, [0, 0.12, 0], '#b3ab9b', { ...FINISH, sides: 24 });
        b.cyl(0.34, 0.05, [0, 0.265, 0], colour, { rough: 0.7, sides: 24 });
      }
      b.group([0, 0.29, 0], () => {
        const neck = animal(b);
        // The stem's cloth tied about the neck, its ends hanging in front.
        b.ring(neck.radius + 0.015, 0.018, neck.at, colour, { rough: 0.75 }, [Math.PI / 2, 0, 0]);
        b.box([0.035, 0.09, 0.012], [neck.at[0] + 0.02, neck.at[1] - 0.05, neck.at[2] + neck.radius + 0.01], colour, { rough: 0.75 }, [0, 0, 0.2]);
      });
    },
    turn,
  );
}

/** Whether `ganji` names one of the sixty: a stem and a branch of the same yin or yang. */
export const isGanji = (ganji: string): boolean => {
  const [stem = '', branch = ''] = [...ganji];
  const s = STEMS.indexOf(stem);
  const r = BRANCHES.indexOf(branch);
  return s >= 0 && r >= 0 && s % 2 === r % 2;
};

/** How far apart the figures of a row stand, in metres. */
export const FIGURE_STEP = 1.0;

/** A chart's pillars as a row of figures about `at`, facing `turn`: the first given (the year) on the right. */
export function ganjiRow(b: Builder, at: V3, ganji: readonly string[], turn = 0): void {
  b.group(
    at,
    () => {
      ganji.forEach((one, index) => {
        if (!isGanji(one)) return;
        // Seen from in front (looking toward -z), the first is on the right: +x.
        const x = ((ganji.length - 1) / 2 - index) * FIGURE_STEP;
        ganjiFigure(b, [x, 0, 0], one);
      });
    },
    turn,
  );
}
