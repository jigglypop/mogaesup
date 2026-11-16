import { BRANCHES, ELEMENT_NAME, ELEMENTS, type Element } from './elements';
import { chartOf, timeBranchOf, timeBranches, type Birth } from './engine';

// 자미두수 명반. jamiblossom draws it in the same calculation as the 사주 (engine.ts, the one file that imports the
// library), and this file only lays that chart out for the panel: the twelve palaces round the ring by earthly branch,
// each one's stars by kind, and the library's codes in the words a 명반 is written in. Nothing is calculated again.

type Chart = ReturnType<typeof chartOf>;
type ChartPalace = Chart['palaces'][number];
type ChartStar = ChartPalace['majorStars'][number] | ChartPalace['adjectiveStars'][number];

/** 사화: what a heavenly stem turns four stars into, 화록·화권·화과·화기. */
export const SAHWA = ['록', '권', '과', '기'] as const;
export type Sahwa = (typeof SAHWA)[number];
const sahwaOf = (text: string | null | undefined): Sahwa | null => SAHWA.find((sahwa) => sahwa === text) ?? null;

/** The kinds a palace's stars are read in, and what a 명반 calls each. */
export const STAR_KINDS = [
  { kind: 'major', label: '주성' },
  { kind: 'lucky', label: '보좌·길성' },
  { kind: 'tough', label: '살성' },
  { kind: 'special', label: '록존·천마' },
  { kind: 'misc', label: '잡성' },
] as const;
export type StarKind = (typeof STAR_KINDS)[number]['kind'];
/** jamiblossom's types of the stars it calls minor, as those kinds. */
const MINOR_KINDS: Record<string, StarKind> = { soft: 'lucky', helper: 'lucky', tough: 'tough', lucun: 'special', tianma: 'special' };

/** How bright a star stands in its palace, as jamiblossom's Korean chart codes it: 묘 the brightest, 함 the dimmest. */
const BRIGHTNESS: Record<string, string> = { '[+3]': '묘', '[+2]': '왕', '[+1]': '득', '[0]': '리', '[-1]': '평', '[-2]': '불', '[-3]': '함' };

export type ZiweiStar = {
  /** The library's own name for the star (`ziweiMaj`): what tells two stars of one reading apart. */
  id: string;
  name: string;
  /** `紫微`; empty when the library gives none. */
  hanja: string;
  kind: StarKind;
  /** 묘·왕·득·리·평·불·함; empty for a star that has no brightness where it stands. */
  brightness: string;
  /** 생년사화: what the birth year's stem turned the star into. */
  sahwa: Sahwa | null;
};

const STEMS = [...'甲乙丙丁戊己庚辛壬癸'];
const STEMS_KO = [...'갑을병정무기경신임계'];
const BRANCHES_KO = [...'자축인묘진사오미신유술해'];
/** Where a stem or branch stands in its table, given by its reading (as jamiblossom's Korean chart gives it) or its character. */
const placeIn = (character: string, readings: readonly string[], characters: readonly string[]) => Math.max(readings.indexOf(character), characters.indexOf(character));

/**
 * Where each earthly branch sits on a 명반, 子 first, as [row, column] of a 4×4 grid from the top left: 巳午未申 along
 * the top, 酉戌 down the right, 亥子丑寅 back along the bottom and 卯辰 up the left. The middle four cells are no branch's.
 */
const RING: readonly (readonly [number, number])[] = [[3, 2], [3, 1], [3, 0], [2, 0], [1, 0], [0, 0], [0, 1], [0, 2], [0, 3], [1, 3], [2, 3], [3, 3]];

/** The four cycles of twelve that go round the palaces, each leaving one of its names in every palace. */
const CYCLES = [
  { key: 'changsheng12', label: '장생' },
  { key: 'boshi12', label: '박사' },
  { key: 'jiangqian12', label: '장전' },
  { key: 'suiqian12', label: '태세' },
] as const;

export type ZiweiPalace = {
  /** Its place in the chart's own order, which begins at 寅 and goes on with the branches. */
  index: number;
  /** `명궁`. */
  name: string;
  /** 간지: `기유` and `己酉`. */
  ganji: { ko: string; hanja: string };
  /** Its earthly branch, 子 0 … 亥 11. */
  branch: number;
  /** Its cell on the 4×4 ring, from the top left. */
  row: number;
  col: number;
  stars: Record<StarKind, ZiweiStar[]>;
  /** 12신: the name each cycle leaves here, 장생·박사·장전·태세 in turn. */
  cycles: { label: string; name: string }[];
  /** 대한: the ten years of life (in the age a 명반 counts) this palace keeps. */
  decade: { from: number; to: number } | null;
  /** 소한: the single years it keeps. */
  ages: number[];
  /** 명궁, 신궁, 래인궁. */
  isSoul: boolean;
  isBody: boolean;
  isOrigin: boolean;
  /** Its 대한 is the one running now. */
  isCurrent: boolean;
  /** 삼방사정: the two palaces in trine with it and the one across, by index; null if the chart names none. */
  surround: { trines: [number, number]; opposite: number } | null;
  /** 비성사화: the palaces this one's stem sends 록·권·과·기 to (itself, for a star of its own). */
  flies: { sahwa: Sahwa; to: number }[];
};

/** One birth's 명반, arranged for drawing. */
export type Ziwei = {
  /** The twelve palaces in the chart's own order. */
  palaces: ZiweiPalace[];
  /** Where the 명궁 is among them, and the 신궁. */
  soul: number;
  body: number | null;
  /** 오행국 (`토오국`), and the element it is named for. */
  bureau: { name: string; element: Element | null };
  /** 명주 and 신주. */
  soulStar: string;
  bodyStar: string;
  /** The birth date in the lunar calendar: `1992년 10월 18일`, or `2020년 윤4월 10일`. */
  lunarDate: string;
  /** 시진: the double hour of the birth (`인시`, `자시(야자)`), and the hours of that day's clock it ran over. */
  hour: { name: string; range: string };
};

function starOf(star: ChartStar, kind: StarKind): ZiweiStar {
  return {
    id: star.key || star.name,
    name: star.name,
    hanja: star.hanja && star.hanja !== star.name ? star.hanja : '',
    kind,
    brightness: 'brightness' in star ? (BRIGHTNESS[star.brightness] ?? star.brightness) : '',
    sahwa: 'mutagen' in star ? sahwaOf(star.mutagen) : null,
  };
}

function palaceOf(chart: Chart, palace: ChartPalace, index: number): ZiweiPalace {
  const stem = placeIn(palace.heavenlyStem, STEMS_KO, STEMS);
  const named = placeIn(palace.earthlyBranch, BRANCHES_KO, BRANCHES);
  // A branch the tables do not know is still the chart's next one: its palaces begin at 寅.
  const branch = named >= 0 ? named : (index + 2) % 12;
  const [row, col] = RING[branch] ?? [0, 0];
  const minor = palace.minorStars.map((star) => starOf(star, MINOR_KINDS[star.type] ?? 'misc'));
  const around = chart.surrounded.find((item) => item.self === index);
  const sent = chart.flies.find((fly) => fly.from === index)?.routes ?? [];
  return {
    index,
    name: palace.name,
    ganji: {
      ko: `${STEMS_KO[stem] ?? palace.heavenlyStem}${BRANCHES_KO[branch] ?? palace.earthlyBranch}`,
      hanja: `${STEMS[stem] ?? ''}${BRANCHES[branch] ?? ''}`,
    },
    branch,
    row,
    col,
    stars: {
      major: palace.majorStars.map((star) => starOf(star, 'major')),
      lucky: minor.filter((star) => star.kind === 'lucky'),
      tough: minor.filter((star) => star.kind === 'tough'),
      special: minor.filter((star) => star.kind === 'special'),
      misc: [...minor.filter((star) => star.kind === 'misc'), ...palace.adjectiveStars.map((star) => starOf(star, 'misc'))],
    },
    cycles: CYCLES.flatMap(({ key, label }) => (palace[key] ? [{ label, name: palace[key] }] : [])),
    decade: palace.stage,
    ages: palace.ages,
    isSoul: palace.earthlyBranch === chart.earthlyBranchOfSoulPalace,
    isBody: palace.isBodyPalace,
    isOrigin: palace.isOriginalPalace,
    isCurrent: chart.horoscope?.decadal?.index === index,
    surround: around ? { trines: around.trine, opposite: around.opposite } : null,
    // A star the chart does not hold has nowhere to fly to; such a route is left out.
    flies: sent.flatMap((route) => {
      const sahwa = sahwaOf(route.mutagenKo);
      return sahwa && route.to !== null && chart.palaces[route.to] ? [{ sahwa, to: route.to }] : [];
    }),
  };
}

/** `1992年10月18日`, as jamiblossom writes a lunar date (閏 before a leap month), in Korean. */
function lunarDateKo(text: string): string {
  const [, year, leap, month, day] = /^(\d+)年(閏?)(\d+)月(\d+)日$/.exec(text) ?? [];
  return year ? `${year}년 ${leap ? '윤' : ''}${month}월 ${day}일` : text;
}

/** The 시진 a birth falls in, named as the form it was entered in names it, with that day's clock hours. */
function hourOf(chart: Chart, time: string): Ziwei['hour'] {
  const solarDate = chart.inputSolarDate ?? chart.solarDate;
  const index = timeBranchOf(solarDate, time);
  const branch = timeBranches(solarDate).find((option) => option.index === index);
  return branch ? { name: `${branch.label}${branch.note ? `(${branch.note})` : ''}`, range: branch.range } : { name: chart.time, range: '' };
}

const drawn = new WeakMap<Chart, Ziwei>();

/**
 * The 명반 of a birth, or null for a birth without an hour: jamiblossom would read that day at noon and draw 午時's
 * chart, which is not this person's.
 * @throws {BirthError} as {@link chartOf} does.
 */
export function ziweiOf(birth: Birth): Ziwei | null {
  if (!birth.time) return null;
  const chart = chartOf(birth);
  const known = drawn.get(chart);
  if (known) return known;
  const palaces = chart.palaces.map((palace, index) => palaceOf(chart, palace, index));
  const body = palaces.findIndex((palace) => palace.isBody);
  const ziwei: Ziwei = {
    palaces,
    soul: Math.max(0, palaces.findIndex((palace) => palace.isSoul)),
    body: body < 0 ? null : body,
    bureau: { name: chart.fiveElementsClass, element: ELEMENTS.find((element) => ELEMENT_NAME[element].ko === chart.fiveElementsClass[0]) ?? null },
    soulStar: chart.soul,
    bodyStar: chart.body,
    lunarDate: lunarDateKo(chart.lunarDate),
    hour: hourOf(chart, birth.time),
  };
  drawn.set(chart, ziwei);
  return ziwei;
}
