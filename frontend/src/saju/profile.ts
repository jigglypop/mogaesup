import { dogOf } from './dogs';
import { balanceOf, branchElement, ELEMENT_NAME, stemElement, type Balance, type Element } from './elements';
import { pillarsOf, readingOf, type Birth, type Reading } from './engine';

/** What stands in the yard for the day master: 甲 a great tree … 癸 a rain cloud. */
export type YardSymbol = 'tree' | 'trellis' | 'sun' | 'candle' | 'mountain' | 'field' | 'anvil' | 'gem' | 'lighthouse' | 'rain';

const DAY_MASTERS: Record<string, { phrase: string; symbol: YardSymbol }> = {
  甲: { phrase: '곧게 뻗는 큰 나무 같은', symbol: 'tree' },
  乙: { phrase: '바람에 춤추는 들꽃 같은', symbol: 'trellis' },
  丙: { phrase: '세상을 비추는 태양 같은', symbol: 'sun' },
  丁: { phrase: '따뜻한 촛불 같은', symbol: 'candle' },
  戊: { phrase: '듬직한 큰 산 같은', symbol: 'mountain' },
  己: { phrase: '만물을 품는 텃밭 같은', symbol: 'field' },
  庚: { phrase: '단단한 무쇠 같은', symbol: 'anvil' },
  辛: { phrase: '반짝이는 보석 같은', symbol: 'gem' },
  壬: { phrase: '깊고 넓은 바다 같은', symbol: 'lighthouse' },
  癸: { phrase: '촉촉한 봄비 같은', symbol: 'rain' },
};

/** 일간: the day pillar's stem, which the rest of the chart is read against. */
export type DayMaster = {
  stem: string;
  /** `정화(丁火)`. */
  label: string;
  element: Element;
};

/** What a 신살 of the chart gives the guardian to keep. */
export type Charm = 'star' | 'cape' | 'canopy' | 'blossom' | 'ribbon' | 'bundle' | 'flag' | 'scarf' | 'books' | 'sword' | 'coins';
/** Where a charm goes; the guardian has one of each at most. */
type Slot = 'above' | 'ear' | 'neck' | 'back' | 'side';

type CharmRule = { charm: Charm; slot: Slot; label: string } & ({ check: string } | { twelve: string });
/** In the order they are given out: the rarer and the more telling first. */
const CHARM_RULES: readonly CharmRule[] = [
  { charm: 'star', slot: 'above', label: '천을귀인의 별', check: 'heavenly-nobleman' },
  { charm: 'cape', slot: 'neck', label: '괴강의 망토', check: 'qigang' },
  { charm: 'canopy', slot: 'above', label: '화개의 꽃양산', twelve: '화개살' },
  { charm: 'blossom', slot: 'ear', label: '도화의 꽃', twelve: '년살(도화)' },
  { charm: 'ribbon', slot: 'neck', label: '홍염의 리본', check: 'red-charm' },
  { charm: 'bundle', slot: 'back', label: '역마의 봇짐', twelve: '역마살' },
  { charm: 'flag', slot: 'back', label: '장성의 깃발', twelve: '장성살' },
  { charm: 'scarf', slot: 'neck', label: '백호의 목도리', check: 'white-tiger' },
  { charm: 'books', slot: 'side', label: '문창의 책', check: 'literary-nobleman' },
  { charm: 'sword', slot: 'side', label: '양인의 검', check: 'yang-blade' },
  { charm: 'coins', slot: 'side', label: '건록의 엽전', check: 'lu' },
];
const MAX_CHARMS = 3;

/** 수호 강아지: the dog that keeps the home's day pillar (see dogs), with what the chart's 신살 gave it. */
export type Guardian = {
  /** Which of the twenty dogs: the name its model is kept under. */
  dog: string;
  /** `왕관 강아지`. */
  name: string;
  /** `정유(丁酉)`. */
  pillar: string;
  charms: { charm: Charm; label: string }[];
};

/** Which of the five houses is built, what the next element adds to its yard, and the day master's symbol. */
export type House = {
  style: Element;
  accent: Element | null;
  symbol: YardSymbol;
};

export const HOUSE_NAME: Record<Element, string> = {
  wood: '숲속 오두막',
  fire: '붉은 벽돌집',
  earth: '황토 기와집',
  metal: '은빛 기와집',
  water: '푸른 지붕 연못집',
};

export type Profile = {
  reading: Reading;
  balance: Balance;
  dayMaster: DayMaster;
  /** `따뜻한 촛불 같은 정화(丁火) 일간`. */
  badge: string;
  house: House;
  guardian: Guardian;
};

/** Whether another pillar carries `name` of the 12신살, counted from the year branch or from the day branch. */
function hasTwelve(reading: Reading, name: string): boolean {
  return reading.sinsal.twelve.some(
    (cell) => (cell.pillar !== 'year' && cell.yearBasis === name) || (cell.pillar !== 'day' && cell.dayBasis === name),
  );
}

function charmsOf(reading: Reading): Guardian['charms'] {
  const matched = new Set(reading.sinsal.checks.filter((check) => check.matched).map((check) => check.id));
  const taken = new Set<Slot>();
  const charms: Guardian['charms'] = [];
  for (const rule of CHARM_RULES) {
    if (charms.length === MAX_CHARMS) break;
    if (taken.has(rule.slot)) continue;
    if (!('check' in rule ? matched.has(rule.check) : hasTwelve(reading, rule.twelve))) continue;
    taken.add(rule.slot);
    charms.push({ charm: rule.charm, label: rule.label });
  }
  return charms;
}

const profiles = new WeakMap<Reading, Profile>();

/** Everything a home shows of a reading: its balance of elements, day master, house and guardian. */
export function profileOfReading(reading: Reading): Profile {
  const known = profiles.get(reading);
  if (known) return known;
  const { day, month } = reading;
  // Both always resolve: jamiblossom's pillars are made of the ten stems and twelve branches.
  const element = stemElement(day.stem) ?? 'earth';
  const monthElement = branchElement(month.branch) ?? element;
  const balance = balanceOf(pillarsOf(reading).flatMap(({ pillar }) => [...pillar.wuxing]), [element, monthElement]);
  const master = DAY_MASTERS[day.stem] ?? DAY_MASTERS['戊']!;
  const label = `${day.stemKo}${ELEMENT_NAME[element].ko}(${day.stem}${ELEMENT_NAME[element].hanja})`;
  const dog = dogOf(day.stem, day.branch);
  const profile: Profile = {
    reading,
    balance,
    dayMaster: { stem: day.stem, label, element },
    badge: `${master.phrase} ${label} 일간`,
    house: { style: balance.dominant, accent: balance.secondary, symbol: master.symbol },
    guardian: {
      dog: dog.id,
      name: dog.name,
      pillar: `${day.ko}(${day.cn})`,
      charms: charmsOf(reading),
    },
  };
  profiles.set(reading, profile);
  return profile;
}

/** Throws a `BirthError` as {@link readingOf} does. */
export const profileOf = (birth: Birth): Profile => profileOfReading(readingOf(birth));
