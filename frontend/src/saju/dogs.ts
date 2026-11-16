import { BRANCHES, STEMS } from './elements';

// 수호 강아지: the twenty dogs that keep the village's homes. A home's dog comes from its day pillar. The sixty pillars
// fall to the twenty dogs three at a time: one day stem with the three branches of one 삼합 (甲 with 申·子·辰, or with
// 寅·午·戌), which is the pillar's place among the sixty counted in twenties. Each element's two stems so have four
// dogs between them, the ones drawn in that element's colours.

export type Dog = {
  /** The name its model is kept under: `01` … `20`, the order the pictures were drawn in. */
  id: string;
  /** `왕관 강아지`. */
  name: string;
};

/** By the day pillar's place among the sixty, modulo twenty: 甲子's first. */
export const DOGS: readonly Dog[] = [
  /* 甲 申子辰 */ { id: '04', name: '공룡 강아지' },
  /* 乙 巳酉丑 */ { id: '12', name: '튤립 강아지' },
  /* 丙 寅午戌 */ { id: '20', name: '점박이 강아지' },
  /* 丁 亥卯未 */ { id: '13', name: '리본 강아지' },
  /* 戊 申子辰 */ { id: '14', name: '머그컵 강아지' },
  /* 己 巳酉丑 */ { id: '16', name: '곰인형 강아지' },
  /* 庚 寅午戌 */ { id: '08', name: '눈썹 강아지' },
  /* 辛 亥卯未 */ { id: '02', name: '솜뭉치 강아지' },
  /* 壬 申子辰 */ { id: '18', name: '목도리 강아지' },
  /* 癸 巳酉丑 */ { id: '01', name: '눈송이 강아지' },
  /* 甲 寅午戌 */ { id: '09', name: '메달 강아지' },
  /* 乙 亥卯未 */ { id: '15', name: '병아리 강아지' },
  /* 丙 申子辰 */ { id: '10', name: '윙크 강아지' },
  /* 丁 巳酉丑 */ { id: '11', name: '왕관 강아지' },
  /* 戊 寅午戌 */ { id: '19', name: '초코 강아지' },
  /* 己 亥卯未 */ { id: '05', name: '베레모 강아지' },
  /* 庚 申子辰 */ { id: '17', name: '뼈다귀 강아지' },
  /* 辛 巳酉丑 */ { id: '06', name: '하트 강아지' },
  /* 壬 寅午戌 */ { id: '03', name: '원반 강아지' },
  /* 癸 亥卯未 */ { id: '07', name: '솜사탕 강아지' },
];

/** A pillar's place among the sixty (甲子 0 … 癸亥 59), or -1 for a stem and branch that never meet. */
export function sexagenaryIndex(stem: string, branch: string): number {
  const s = STEMS.indexOf(stem);
  const b = BRANCHES.indexOf(branch);
  // A stem meets only the branches of its own kind, 양 with 양 and 음 with 음.
  if (s < 0 || b < 0 || (s - b) % 2 !== 0) return -1;
  return (6 * s - 5 * b + 60) % 60;
}

/** The dog that keeps a home whose day pillar is `stem` over `branch`. */
export function dogOf(stem: string, branch: string): Dog {
  return DOGS[Math.max(0, sexagenaryIndex(stem, branch)) % DOGS.length]!;
}
