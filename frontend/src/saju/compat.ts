import { ELEMENT_NAME, elementLabel, hangulOf, relationOf, type Element } from './elements';
import type { Profile } from './profile';

/** 천간합: the five pairs of stems that join. */
const STEM_UNIONS: Record<string, string> = {
  甲己: '큰 나무와 너른 땅처럼 믿음이 자라는 사이',
  乙庚: '부드러움과 단단함이 서로를 완성하는 사이',
  丙辛: '햇살이 보석을 비추듯 서로를 빛내는 사이',
  丁壬: '촛불이 밤바다를 물들이듯 마음이 통하는 사이',
  戊癸: '큰 산에 단비가 내리듯 서로를 채워 주는 사이',
};
/** 지지 육합. */
const BRANCH_UNIONS = ['子丑', '寅亥', '卯戌', '辰酉', '巳申', '午未'];
/** 삼합: two branches of one of these lean the same way (반합). */
const BRANCH_TRIADS = ['申子辰', '寅午戌', '巳酉丑', '亥卯未'];
/** 지지 충. */
const BRANCH_CLASHES = ['子午', '丑未', '寅申', '卯酉', '辰戌', '巳亥'];

/** 상생, by the element that gives. */
const FLOWS: Record<Element, string> = {
  wood: '서로 영감을 주는 사이',
  fire: '따뜻하게 품어 주는 사이',
  earth: '묵묵히 빛나게 해 주는 사이',
  metal: '맑은 생각이 샘솟는 사이',
  water: '촉촉하게 키워 주는 사이',
};
const SAMES: Record<Element, string> = {
  wood: '나란히 숲을 이루는 사이',
  fire: '함께 있으면 더 환해지는 사이',
  earth: '든든하게 기댈 수 있는 사이',
  metal: '서로를 반짝이게 닦아 주는 사이',
  water: '한 물결로 흐르는 사이',
};
/** 상극, by the element that holds the other back. */
const SPARKS: Record<Element, string> = {
  wood: '뿌리가 흙을 붙잡듯 서로를 단단하게 하는 사이',
  fire: '뜨겁게 달궈 새 모습을 빚어 주는 사이',
  earth: '둑이 물길을 잡듯 균형을 맞춰 주는 사이',
  metal: '가지를 다듬어 곧게 키워 주는 사이',
  water: '열기를 식히며 균형을 맞춰 주는 사이',
};

/** What the bridge between two homes is made of: a joining (합), a flow (상생), a likeness (비화) or a spark (상극). */
export type CompatTone = 'union' | 'flow' | 'same' | 'spark';

export type Compat = {
  /** `목생화(木生火) 시너지! 서로 영감을 주는 사이`. */
  headline: string;
  tone: CompatTone;
  /** The ties found between the two charts, the headline's own among them. */
  notes: string[];
  /** The two homes' elements, the bridge's ends: the viewer's, then the other's. */
  from: Element;
  to: Element;
};

/** `a` and `b` in whichever order `pairs` writes them, or null when they are not a pair. */
function pairIn(pairs: readonly string[], a: string, b: string): string | null {
  return pairs.find((pair) => pair === a + b || pair === b + a) ?? null;
}

/** Two different branches of one 삼합, in the order the three are named (`酉丑` of 巳酉丑), or null. */
function halfTriadOf(a: string, b: string): string | null {
  const group = a === b ? undefined : BRANCH_TRIADS.find((triad) => triad.includes(a) && triad.includes(b));
  return group ? [...group].filter((branch) => branch === a || branch === b).join('') : null;
}
const koPair = (pair: string) => [...pair].map(hangulOf).join('');
/** 목 and 금 end in a consonant, which the particle after them follows. */
const closed = (element: Element) => element === 'wood' || element === 'metal';
const asObject = (element: Element) => `${elementLabel(element)}${closed(element) ? '을' : '를'}`;
const asSubject = (element: Element) => `${elementLabel(element)}${closed(element) ? '이' : '가'}`;

/** `목생화(木生火)`, `목극토(木克土)`: `giver` acting on `taker`. */
function act(giver: Element, verb: '生' | '克', taker: Element): string {
  const ko = verb === '生' ? '생' : '극';
  return `${ELEMENT_NAME[giver].ko}${ko}${ELEMENT_NAME[taker].ko}(${ELEMENT_NAME[giver].hanja}${verb}${ELEMENT_NAME[taker].hanja})`;
}

/**
 * 궁합: how the viewer's home stands to another. The two day pillars are looked at for a joining (천간합, 육합), then the
 * two homes' elements for 상생; whichever comes first gives the one line, and every tie found is listed.
 */
export function compatOf(mine: Profile, theirs: Profile): Compat {
  const from = mine.balance.dominant;
  const to = theirs.balance.dominant;
  const myDay = mine.reading.day;
  const theirDay = theirs.reading.day;
  const notes: string[] = [];

  const stemUnion = pairIn(Object.keys(STEM_UNIONS), myDay.stem, theirDay.stem);
  if (stemUnion) notes.push(`일간 ${koPair(stemUnion)}합(${stemUnion}合)`);

  const branchUnion = pairIn(BRANCH_UNIONS, myDay.branch, theirDay.branch);
  const halfTriad = halfTriadOf(myDay.branch, theirDay.branch);
  const clash = pairIn(BRANCH_CLASHES, myDay.branch, theirDay.branch);
  if (branchUnion) notes.push(`일지 ${koPair(branchUnion)}합(${branchUnion}合)`);
  else if (halfTriad) notes.push(`일지 ${koPair(halfTriad)} 반합(${halfTriad})`);
  else if (clash) notes.push(`일지 ${koPair(clash)}충(${clash}沖)`);

  const relation = relationOf(from, to);
  const [giver, taker] = relation === 'generates' || relation === 'controls' ? [from, to] : [to, from];
  const houses =
    relation === 'same'
      ? `같은 ${elementLabel(from)}`
      : act(giver, relation === 'generates' || relation === 'generated' ? '生' : '克', taker);
  notes.push(`집 ${houses}`);

  if (mine.balance.lacking.includes(to)) notes.push(`내게 없는 ${asObject(to)} 채워 주는 집`);
  else if (theirs.balance.lacking.includes(from)) notes.push(`내 ${asSubject(from)} 채워 주는 집`);

  let headline: string;
  let tone: CompatTone;
  if (stemUnion) {
    headline = `${koPair(stemUnion)}합(${stemUnion}合) 인연! ${STEM_UNIONS[stemUnion]}`;
    tone = 'union';
  } else if (branchUnion) {
    headline = `${koPair(branchUnion)}합(${branchUnion}合) 단짝! 곁에 있으면 마음이 편안한 사이`;
    tone = 'union';
  } else if (relation === 'generates' || relation === 'generated') {
    headline = `${houses} 시너지! ${FLOWS[giver]}`;
    tone = 'flow';
  } else if (relation === 'same') {
    headline = `${houses} 기운! ${SAMES[from]}`;
    tone = 'same';
  } else if (halfTriad) {
    headline = `${koPair(halfTriad)}(${halfTriad}) 반합! 같은 꿈을 꾸는 사이`;
    tone = 'union';
  } else {
    headline = `${houses} 자극! ${SPARKS[giver]}`;
    tone = 'spark';
  }
  return { headline, tone, notes, from, to };
}
