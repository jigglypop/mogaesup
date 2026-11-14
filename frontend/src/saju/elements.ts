/** 오행, in the order each gives rise to the next: 목 → 화 → 토 → 금 → 수 → 목. */
export const ELEMENTS = ['wood', 'fire', 'earth', 'metal', 'water'] as const;
export type Element = (typeof ELEMENTS)[number];

export const ELEMENT_NAME: Record<Element, { ko: string; hanja: string }> = {
  wood: { ko: '목', hanja: '木' },
  fire: { ko: '화', hanja: '火' },
  earth: { ko: '토', hanja: '土' },
  metal: { ko: '금', hanja: '金' },
  water: { ko: '수', hanja: '水' },
};

/** `목(木)`. */
export const elementLabel = (element: Element) => `${ELEMENT_NAME[element].ko}(${ELEMENT_NAME[element].hanja})`;

const BY_HANJA: Record<string, Element> = { 木: 'wood', 火: 'fire', 土: 'earth', 金: 'metal', 水: 'water' };
export const elementOfHanja = (hanja: string): Element | null => BY_HANJA[hanja] ?? null;

/** 상생: the element `element` gives rise to. */
export const generates = (element: Element): Element => ELEMENTS[(ELEMENTS.indexOf(element) + 1) % 5]!;
/** 상극: the element `element` holds back. */
export const controls = (element: Element): Element => ELEMENTS[(ELEMENTS.indexOf(element) + 2) % 5]!;

/** How `from` stands to `to`: the same, giving rise to it (or risen from it), or holding it back (or held back by it). */
export type Relation = 'same' | 'generates' | 'generated' | 'controls' | 'controlled';
export function relationOf(from: Element, to: Element): Relation {
  if (from === to) return 'same';
  if (generates(from) === to) return 'generates';
  if (generates(to) === from) return 'generated';
  return controls(from) === to ? 'controls' : 'controlled';
}

const STEMS = [...'甲乙丙丁戊己庚辛壬癸'];
const STEMS_KO = [...'갑을병정무기경신임계'];
export const BRANCHES = [...'子丑寅卯辰巳午未申酉戌亥'];
const BRANCHES_KO = [...'자축인묘진사오미신유술해'];
/** Each branch's own element, 子 first. */
const BRANCH_ELEMENTS: readonly Element[] = ['water', 'earth', 'wood', 'wood', 'earth', 'fire', 'fire', 'earth', 'metal', 'metal', 'earth', 'water'];

export function stemElement(stem: string): Element | null {
  const index = STEMS.indexOf(stem);
  return index < 0 ? null : ELEMENTS[Math.floor(index / 2)]!;
}
export function branchElement(branch: string): Element | null {
  return BRANCH_ELEMENTS[BRANCHES.indexOf(branch)] ?? null;
}
/** The Korean reading of a stem or branch (`丁` → `정`), or the character itself when it is neither. */
export function hangulOf(character: string): string {
  return STEMS_KO[STEMS.indexOf(character)] ?? BRANCHES_KO[BRANCHES.indexOf(character)] ?? character;
}

/** How the eight (or, without a birth hour, six) characters of a chart divide among the five elements. */
export type Balance = {
  counts: Record<Element, number>;
  total: number;
  /** Whole percentages that add up to 100. */
  percent: Record<Element, number>;
  /** Most characters first. */
  ranked: Element[];
  dominant: Element;
  /** The next element the chart holds, if it holds another. */
  secondary: Element | null;
  /** Elements without a single character. */
  lacking: Element[];
};

/**
 * Counts the elements of `characters` (each a 木火土金水 character, a stem's or a branch's). Elements with as many
 * characters as each other rank in the order of `prefer` (the day master's element, then the month branch's), then in
 * the order of {@link ELEMENTS}.
 */
export function balanceOf(characters: readonly string[], prefer: readonly Element[] = []): Balance {
  const counts: Record<Element, number> = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };
  for (const character of characters) {
    const element = elementOfHanja(character);
    if (element) counts[element] += 1;
  }
  const total = ELEMENTS.reduce((sum, element) => sum + counts[element], 0);
  const order = [...new Set<Element>([...prefer, ...ELEMENTS])];
  const ranked = [...ELEMENTS].sort((a, b) => counts[b] - counts[a] || order.indexOf(a) - order.indexOf(b));
  return {
    counts,
    total,
    percent: wholePercents(counts, total, ranked),
    ranked,
    dominant: ranked[0]!,
    secondary: counts[ranked[1]!] > 0 ? ranked[1]! : null,
    lacking: ELEMENTS.filter((element) => counts[element] === 0),
  };
}

/** Largest remainders: each share rounded down, then the points left over go to the largest fractions, ranked first. */
function wholePercents(counts: Record<Element, number>, total: number, ranked: readonly Element[]): Record<Element, number> {
  const percent: Record<Element, number> = { wood: 0, fire: 0, earth: 0, metal: 0, water: 0 };
  if (total === 0) return percent;
  const fractions = ranked.map((element) => {
    const exact = (counts[element] * 100) / total;
    percent[element] = Math.floor(exact);
    return { element, fraction: exact - Math.floor(exact) };
  });
  let left = 100 - ELEMENTS.reduce((sum, element) => sum + percent[element], 0);
  for (const { element } of fractions.sort((a, b) => b.fraction - a.fraction)) {
    if (left <= 0) break;
    percent[element] += 1;
    left -= 1;
  }
  return percent;
}
