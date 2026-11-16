import { BRANCHES, elementOfHanja, hangulOf, STEMS, stemElement, type Element } from './elements';
import type { Pillar, PillarKey, Reading } from './engine';
import { motifName, MOTIFS, suits, type MotifId, type Place, type Zone } from './motifs';
import { profileOfReading, type YardSymbol } from './profile';

// 물상: the picture each of the sixty 간지 makes, and what a home draws of it. The four pillars are read as 근묘화실
// (根苗花實), root, sprout, flower and fruit, twice over. On the house, from its foot to its door: the 년주 is the stone it
// stands on, the 월주 the flowers at its windows, the 일주 its door, its eaves and what is on its roof or porch, the 시주
// the shoes on its step. On the island, from the far side to the near one as the untouched camera sees it: the 년주 the
// far land and shore, the 월주 the garden and the season, the 일주 the house, the 시주 the fruit trees and the small
// lives in front. In each pillar the 납음, the pair's own picture, chooses the zone's main thing, the branch holds the
// season and the ground, the stem gives colour. One season holds the island, the month branch's (월령): every other
// branch chooses only a kind of thing, and the season decides how it looks, so nothing blooms, fruits or hangs out of
// its month. The house stays the chart's own: built of its strongest element, the day master's emblem and the second
// element's keepsake by it, and no pillar draws what the house, its yard, its emblem or its keepsake already shows.

export type { MotifId, Place, Zone } from './motifs';

/** Freezes a table and everything in it: what the module hands out is shared, and no caller may change it for the next. */
function frozen<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) frozen(inner);
  }
  return value;
}

/** A motif as one of the tables asks for it: in its plain form, or as one of its kinds. */
export type Choice = MotifId | { readonly motif: MotifId; readonly variant: string };
const kind = (motif: MotifId, variant: string): Choice => ({ motif, variant });
const motifOf = (choice: Choice): MotifId => (typeof choice === 'string' ? choice : choice.motif);
const variantOf = (choice: Choice): string | undefined => (typeof choice === 'string' ? undefined : choice.variant);

/** The house's dressings, one for each pillar (see {@link Dress}). */
export type DressKey = 'stone' | 'flowers' | 'door' | 'shoes';

/** What a pillar stands for in 근묘화실 and the 궁위, and what of the house and the island it draws. */
export type PillarRole = {
  zone: Zone;
  /** `根`. */
  hanja: string;
  /** `뿌리`. */
  ko: string;
  /** Whom and what it stands for. */
  stands: string;
  /** What of the house it dresses, and which of the plan's dressings that is. */
  house: string;
  dresses: DressKey;
  /** What of the island it draws. */
  island: string;
};

export const PILLAR_ROLES: Readonly<Record<PillarKey, Readonly<PillarRole>>> = frozen({
  year: { zone: 'land', hanja: '根', ko: '뿌리', stands: '조상과 태어난 터', house: '기단과 섬돌의 돌', dresses: 'stone', island: '먼 땅과 먼 물가' },
  month: { zone: 'garden', hanja: '苗', ko: '싹', stands: '부모와 사회, 태어난 계절', house: '화분과 창가의 꽃', dresses: 'flowers', island: '뜰과 섬의 계절' },
  day: { zone: 'house', hanja: '花', ko: '꽃', stands: '나와 배우자', house: '문과 처마, 지붕이나 문간의 장식', dresses: 'door', island: '마당의 상징물과 수호 강아지' },
  hour: { zone: 'details', hanja: '實', ko: '열매', stands: '자식과 앞날', house: '댓돌 위 신발', dresses: 'shoes', island: '앞 과수원과 앞길, 작은 생명' },
});

/** One of the thirty 납음, and what it draws in each zone: the first of them that is free and suits the house, first. */
export type Nayin = {
  /** As jamiblossom spells it: `炉中火`. */
  cn: string;
  /** As it is written in Korean: `爐中火`. */
  hanja: string;
  /** `노중화`. */
  ko: string;
  element: Element;
  /** `화로 속의 불`: its picture, as 三命通會 「論納音取象」 reads it where that differs from the name's letters. */
  image: string;
  draws: Readonly<Record<Zone, readonly Choice[]>>;
};

type NayinRow = Omit<Nayin, 'element'>;

/**
 * In the order of the sixty, each the 납음 of two 간지 running: 甲子 and 乙丑 are 해중금. Each zone's choices are its
 * picture drawn at that zone's scale; the second is drawn when the first is on the island already or does not suit
 * the house. No two give the house the same first thing, so the 일주 of every 납음 dresses the house its own way.
 */
const NAYIN_ROWS: readonly NayinRow[] = [
  { cn: '海中金', hanja: '海中金', ko: '해중금', image: '바다 속에 잠긴 금', draws: { land: ['pearlShell', 'sandbank'], garden: ['pond', 'spring'], house: ['pearlShell', 'net'], details: [kind('stringLights', 'pearls'), 'pearlShell'] } },
  { cn: '炉中火', hanja: '爐中火', ko: '노중화', image: '화로 속의 불', draws: { land: ['kiln', 'beacon'], garden: ['hearth', 'bonfire'], house: ['brazier', kind('candles', 'oilLamp')], details: ['stoneLamp', kind('candles', 'oilLamp')] } },
  { cn: '大林木', hanja: '大林木', ko: '대림목', image: '큰 숲의 나무', draws: { land: ['oldTree', 'forestEdge'], garden: ['bamboo', 'saplings'], house: ['ivy', 'woodpile'], details: ['sotdae', 'swing'] } },
  { cn: '路旁土', hanja: '路傍土', ko: '노방토', image: '길가의 흙', draws: { land: ['sotdae', 'standingStones'], garden: ['dirtPath', 'cart'], house: ['jige', 'mill'], details: ['signpost', 'cart'] } },
  { cn: '剑锋金', hanja: '劍鋒金', ko: '검봉금', image: '칼끝의 쇠', draws: { land: ['standingStones', 'crystals'], garden: ['irises', 'rockHill'], house: ['weathercock', 'hairpin'], details: ['windChime', 'crystals'] } },
  { cn: '山头火', hanja: '山頭火', ko: '산두화', image: '산마루의 불', draws: { land: [kind('rockHill', 'lit'), 'beacon'], garden: ['bonfire', kind('stringLights', 'silk')], house: [kind('sunDisc', 'rising'), 'silkLantern'], details: [kind('stringLights', 'silk'), 'stoneLamp'] } },
  { cn: '涧下水', hanja: '澗下水', ko: '간하수', image: '골짜기 아래 흐르는 물', draws: { land: ['brook', 'well'], garden: ['spring', 'brook'], house: ['fishTrap', 'waterJar'], details: ['spring', 'fishTrap'] } },
  { cn: '城头土', hanja: '城頭土', ko: '성두토', image: '성 위의 흙', draws: { land: ['stoneWall', 'earthWall'], garden: ['gate', 'flowerArch'], house: ['magpie', 'ivy'], details: ['pots', 'stoneLamp'] } },
  { cn: '白蜡金', hanja: '白蠟金', ko: '백랍금', image: '아직 광석 속에 든 흰 쇠', draws: { land: ['crystals', 'birches'], garden: ['beehive', 'candles'], house: ['candles', 'gilt'], details: ['candles', 'crystals'] } },
  { cn: '杨柳木', hanja: '楊柳木', ko: '양류목', image: '버드나무', draws: { land: ['willow', 'forestEdge'], garden: ['willow', 'swing'], house: ['blind', 'ivy'], details: ['swing', 'stoneLamp'] } },
  { cn: '泉中水', hanja: '泉中水', ko: '천중수', image: '샘 속의 물', draws: { land: ['well', 'brook'], garden: ['spring', 'well'], house: ['spring', 'waterJar'], details: ['waterJar', 'spring'] } },
  { cn: '屋上土', hanja: '屋上土', ko: '옥상토', image: '지붕 위의 흙', draws: { land: ['kiln', 'earthWall'], garden: ['jars', 'gate'], house: ['gourds', 'magpie'], details: ['jars', 'stoneLamp'] } },
  { cn: '霹雳火', hanja: '霹靂火', ko: '벽력화', image: '벼락의 불', draws: { land: ['rockHill', 'beacon'], garden: [kind('rainCloud', 'storm'), 'bonfire'], house: ['lightningRod', 'weathercock'], details: [kind('stringLights', 'bulbs'), 'candles'] } },
  { cn: '松柏木', hanja: '松柏木', ko: '송백목', image: '소나무와 잣나무', draws: { land: ['pines', 'forestEdge'], garden: ['bonsai', 'pines'], house: ['bonsai', 'ivy'], details: ['bonsai', 'stoneLamp'] } },
  { cn: '长流水', hanja: '長流水', ko: '장류수', image: '길게 흐르는 물', draws: { land: ['waterwheel', 'brook'], garden: ['brook', 'waterwheel'], house: ['rainChain', 'waterJar'], details: [kind('stringLights', 'lotus'), 'spring'] } },
  { cn: '沙中金', hanja: '沙中金', ko: '사중금', image: '모래 속의 금', draws: { land: ['goldSand', 'sandbank'], garden: ['sunflowers', 'forsythia'], house: ['windChime', 'gilt'], details: ['crystals', 'windChime'] } },
  { cn: '山下火', hanja: '山下火', ko: '산하화', image: '산 아래의 불', draws: { land: [kind('rockHill', 'lit'), 'kiln'], garden: ['candles', 'bonfire'], house: [kind('candles', 'oilLamp'), 'silkLantern'], details: [kind('candles', 'oilLamp'), 'candles'] } },
  { cn: '平地木', hanja: '平地木', ko: '평지목', image: '뿌리로 돌아가 땅에 엎드린 나무', draws: { land: ['saplings', 'oldTree'], garden: ['vegetableRows', 'saplings'], house: ['woodpile', 'jige'], details: ['mushrooms', 'cart'] } },
  { cn: '壁上土', hanja: '壁上土', ko: '벽상토', image: '벽 위의 흙', draws: { land: ['earthWall', 'stoneWall'], garden: ['earthWall', 'jars'], house: ['swallowNest', 'ivy'], details: ['jars', 'pots'] } },
  { cn: '金箔金', hanja: '金箔金', ko: '금박금', image: '얇게 편 금', draws: { land: ['ginkgo', 'birches'], garden: ['forsythia', 'sunflowers'], house: ['gilt', 'hairpin'], details: [kind('stringLights', 'bulbs'), 'windChime'] } },
  { cn: '覆灯火', hanja: '覆燈火', ko: '복등화', image: '갓 씌운 등불', draws: { land: ['stoneLamp', 'beacon'], garden: [kind('stringLights', 'silk'), 'candles'], house: ['silkLantern', kind('candles', 'oilLamp')], details: ['silkLantern', 'stoneLamp'] } },
  { cn: '天河水', hanja: '天河水', ko: '천하수', image: '하늘에서 내리는 비', draws: { land: ['well', 'brook'], garden: ['rainCloud', 'pond'], house: ['umbrella', 'rainChain'], details: ['umbrella', kind('stringLights', 'pearls')] } },
  { cn: '大驿土', hanja: '大驛土', ko: '대역토', image: '큰 역참 길의 흙', draws: { land: ['pavilion', 'standingStones'], garden: ['dirtPath', 'cart'], house: ['baskets', 'jige'], details: ['cart', 'signpost'] } },
  { cn: '钗钏金', hanja: '釵釧金', ko: '차천금', image: '비녀와 팔찌의 금', draws: { land: ['crystals', 'standingStones'], garden: ['flowerArch', 'irises'], house: ['hairpin', 'gilt'], details: ['pearlShell', 'windChime'] } },
  { cn: '桑柘木', hanja: '桑柘木', ko: '상자목', image: '뽕나무', draws: { land: ['mulberry', 'forestEdge'], garden: ['mulberry', 'clothesline'], house: [kind('baskets', 'cocoons'), 'blind'], details: ['mulberry', 'cart'] } },
  { cn: '大溪水', hanja: '大溪水', ko: '대계수', image: '큰 시냇물', draws: { land: ['brook', 'waterwheel'], garden: ['brook', 'pond'], house: ['waterJar', 'fishTrap'], details: ['fishTrap', kind('stringLights', 'lotus')] } },
  { cn: '沙中土', hanja: '沙中土', ko: '사중토', image: '모래 속의 흙', draws: { land: ['sandbank', 'goldSand'], garden: ['vegetableRows', 'jars'], house: ['mill', 'gourds'], details: ['cart', 'jars'] } },
  { cn: '天上火', hanja: '天上火', ko: '천상화', image: '하늘 위의 불', draws: { land: ['sunflowers', 'beacon'], garden: ['sunflowers', kind('stringLights', 'bulbs')], house: ['sunDisc', 'silkLantern'], details: [kind('stringLights', 'bulbs'), 'candles'] } },
  { cn: '石榴木', hanja: '石榴木', ko: '석류목', image: '석류나무', draws: { land: ['pomegranate', 'oldTree'], garden: ['pomegranate', 'flowerArch'], house: [kind('bonsai', 'pomegranate'), 'ivy'], details: ['pomegranate', 'pots'] } },
  { cn: '大海水', hanja: '大海水', ko: '대해수', image: '큰 바다', draws: { land: ['boat', 'sandbank'], garden: ['pond', 'brook'], house: ['net', 'pearlShell'], details: ['pearlShell', kind('stringLights', 'pearls')] } },
];

/** The thirty 납음, 해중금 first. */
export const NAYINS: readonly Nayin[] = frozen(NAYIN_ROWS.map((row) => ({ ...row, element: elementOfHanja(row.cn.slice(-1)) ?? 'earth' })));

/**
 * What a 납음 draws when its own choices are all on the island already or do not suit the house: something else of
 * its element, so a pillar is never left out because the house or another pillar came first.
 */
export const ELEMENT_DRAWS: Readonly<Record<Element, Readonly<Record<Zone, readonly Choice[]>>>> = frozen({
  wood: { land: ['pines', 'willow', 'saplings', 'bamboo', 'oldTree', 'birches'], garden: ['saplings', 'bamboo', 'pines', 'willow', 'forsythia'], house: ['ivy', 'bonsai', 'woodpile', 'blind'], details: ['mushrooms', 'swing', 'sotdae', 'stoneLamp'] },
  fire: { land: ['beacon', 'kiln', kind('rockHill', 'lit'), 'stoneLamp'], garden: ['bonfire', 'hearth', kind('stringLights', 'bulbs'), 'candles'], house: ['silkLantern', 'brazier', kind('candles', 'oilLamp'), 'sunDisc', 'candles'], details: ['candles', 'silkLantern', 'stoneLamp', kind('stringLights', 'bulbs')] },
  earth: { land: ['earthWall', 'standingStones', 'sotdae', 'stoneWall', 'pavilion'], garden: ['jars', 'dirtPath', 'gate', 'vegetableRows', 'cart'], house: ['jige', 'baskets', 'mill', 'gourds', 'woodpile'], details: ['jars', 'pots', 'signpost', 'cart'] },
  metal: { land: ['crystals', 'standingStones', 'rockHill', 'birches'], garden: ['irises', 'bonsai', 'rockHill', 'flowerArch'], house: ['gilt', 'hairpin', 'windChime', 'weathercock', 'lightningRod'], details: ['windChime', 'crystals', 'pearlShell'] },
  water: { land: ['brook', 'well', 'sandbank', 'boat'], garden: ['pond', 'spring', 'brook', 'rainCloud'], house: ['waterJar', 'fishTrap', 'umbrella', 'net', 'rainChain'], details: ['spring', 'waterJar', kind('stringLights', 'lotus'), 'pearlShell'] },
});

/** What any pillar falls back on last, when even its element's choices are taken: what every country house has. */
export const PLAIN_DRAWS: Readonly<Record<Zone, readonly Choice[]>> = frozen({
  land: ['saplings', 'standingStones', 'stoneLamp'],
  garden: ['saplings', 'jars', 'cart'],
  house: ['magpie', 'ivy', 'woodpile', 'waterJar'],
  details: ['pots', 'signpost', 'cart', 'mushrooms'],
});

/** What the flower beds of a garden hold, by the month stem. */
export type BedKind = 'hedge' | 'flowers' | 'tall' | 'lanterns' | 'rocks' | 'rows' | 'edged' | 'gravel' | 'water' | 'moss';
/** How the banks are dressed, by the year branch. */
export type ShoreKind = 'pebbles' | 'rocks' | 'ferns' | 'flowers' | 'reeds' | 'sand' | 'grass' | 'shells';
/** What lives about the front yard: the hour stem's in its months, else the birds that stay all year. */
export type Creature = Extract<MotifId, 'butterflies' | 'fireflies' | 'chicks' | 'dragonflies' | 'ducks' | 'sparrows' | 'magpie'>;
/**
 * How a tree that flowers and fruits stands in the island's month: `bare` (twigs only; under snow, a little of it on
 * the boughs), `bud` (bare boughs, the flower buds swelling, before a deciduous tree flowers), `blossom`, `leaf` (an
 * evergreen's every month it is not in flower or fruit), `fruit`, or `lastFruit`, bare but for a few fruit left for
 * the magpies (까치밥).
 */
export type TreeState = 'bare' | 'bud' | 'blossom' | 'leaf' | 'fruit' | 'lastFruit';

export const BED_NAME: Readonly<Record<BedKind, string>> = frozen({
  hedge: '생울타리 두른 꽃밭',
  flowers: '꽃 가득한 꽃밭',
  tall: '키 큰 꽃밭',
  lanterns: '등불 켠 꽃밭',
  rocks: '돌 사이 꽃밭',
  rows: '줄지은 꽃밭',
  edged: '돌테 두른 꽃밭',
  gravel: '흰 자갈 꽃밭',
  water: '물가 꽃밭',
  moss: '이끼 정원',
});

export const SHORE_NAME: Readonly<Record<ShoreKind, string>> = frozen({
  pebbles: '조약돌 물가',
  rocks: '바위 물가',
  ferns: '고사리 물가',
  flowers: '들꽃 물가',
  reeds: '갈대 물가',
  sand: '모래 물가',
  grass: '억새 물가',
  shells: '조개 물가',
});

export const TREE_STATE_NAME: Readonly<Record<TreeState, string>> = frozen({ bare: '맨가지', bud: '꽃봉오리', blossom: '꽃', leaf: '잎', fruit: '열매', lastFruit: '까치밥' });

/** A stem's 물상, and what it gives a garden's beds and a front yard. */
export type StemImage = { image: string; beds: BedKind; creature: Creature };

/** By {@link STEMS}: 甲 first. The creatures follow the element: 목 나비, 화 반딧불이, 토 병아리, 금 잠자리, 수 오리. */
const STEM_IMAGES: readonly StemImage[] = frozen([
  { image: '큰 나무', beds: 'hedge', creature: 'butterflies' },
  { image: '화초와 덩굴', beds: 'flowers', creature: 'butterflies' },
  { image: '태양', beds: 'tall', creature: 'fireflies' },
  { image: '등불과 별', beds: 'lanterns', creature: 'fireflies' },
  { image: '큰 산', beds: 'rocks', creature: 'chicks' },
  { image: '논밭과 정원', beds: 'rows', creature: 'chicks' },
  { image: '바위와 무쇠', beds: 'edged', creature: 'dragonflies' },
  { image: '보석과 서리', beds: 'gravel', creature: 'dragonflies' },
  { image: '바다와 큰 강', beds: 'water', creature: 'ducks' },
  { image: '비와 이슬', beds: 'moss', creature: 'ducks' },
]);

/**
 * The months each creature is about, by month branch: butterflies from 卯 to 酉, fireflies 午 to 申, chicks 卯 to 午,
 * dragonflies 午 to 戌; ducks all year (mallards and mandarin ducks winter on Korean water). Out of its months a
 * stem's creature gives way to the birds that stay: magpies for 금, sparrows for the rest.
 */
const CREATURE_MONTHS: Readonly<Record<Creature, string>> = frozen({
  butterflies: '卯辰巳午未申酉',
  fireflies: '午未申',
  chicks: '卯辰巳午',
  dragonflies: '午未申酉戌',
  ducks: '子丑寅卯辰巳午未申酉戌亥',
  sparrows: '子丑寅卯辰巳午未申酉戌亥',
  magpie: '子丑寅卯辰巳午未申酉戌亥',
});

/** The time of year a month branch holds: 寅 초봄 … 丑 늦겨울, and how the island looks in it. */
export type Season = {
  /** The month branch: `寅`. */
  branch: string;
  key: 'spring' | 'summer' | 'autumn' | 'winter';
  /** 孟·仲·季: the season's first, middle or last month. */
  stage: 'early' | 'mid' | 'late';
  /** `초봄`. */
  ko: string;
  /** What a deciduous crown shows: its leaves, or in the snow months its bare twigs. */
  leaves: readonly string[];
  /** How full those crowns are: 1 in summer, a haze of buds in early spring, little in winter. */
  foliage: number;
  grass: readonly string[];
  /** The colours of what is in flower, and its names. */
  blooms: readonly string[];
  flowers: readonly string[];
  /** What drifts down. */
  falling: 'petals' | 'leaves' | 'snow' | null;
  /** What whitens the roofs and the ground. */
  cover: 'frost' | 'snow' | null;
};

/** A tree that flowers and fruits: the fruit trees' kinds, and the two that stand as motifs of their own. */
export type TreeKind = 'camellia' | 'plum' | 'cherry' | 'peach' | 'nankingCherry' | 'apricot' | 'grape' | 'persimmon' | 'citron' | 'mulberry' | 'pomegranate';

/**
 * How each kind stands in each month, by {@link BRANCHES} (子 first), as it does in a Korean garden: the camellia in
 * flower from 子 to 卯, the plum from 寅, the apricot in 卯, the cherry, the peach and the 앵두 in 辰; 앵두 and 버찌 in
 * 巳, 오디 and apricots in 午, peaches in 未 and 申, grapes in 申 and 酉, pomegranates in 酉 and 戌, persimmons in 戌
 * and hanging on bare boughs through 亥 and 子, citrons yellow from 戌 to 子.
 */
export const PHENOLOGY: Readonly<Record<TreeKind, readonly TreeState[]>> = frozen({
  camellia: ['blossom', 'blossom', 'blossom', 'blossom', 'leaf', 'leaf', 'leaf', 'leaf', 'leaf', 'leaf', 'leaf', 'leaf'],
  plum: ['bare', 'bud', 'blossom', 'blossom', 'leaf', 'fruit', 'fruit', 'leaf', 'leaf', 'leaf', 'leaf', 'bare'],
  cherry: ['bare', 'bare', 'bare', 'bud', 'blossom', 'fruit', 'leaf', 'leaf', 'leaf', 'leaf', 'leaf', 'bare'],
  peach: ['bare', 'bare', 'bare', 'bud', 'blossom', 'leaf', 'leaf', 'fruit', 'fruit', 'leaf', 'leaf', 'bare'],
  nankingCherry: ['bare', 'bare', 'bare', 'bud', 'blossom', 'fruit', 'fruit', 'leaf', 'leaf', 'leaf', 'leaf', 'bare'],
  apricot: ['bare', 'bare', 'bud', 'blossom', 'leaf', 'leaf', 'fruit', 'leaf', 'leaf', 'leaf', 'leaf', 'bare'],
  grape: ['bare', 'bare', 'bare', 'bare', 'leaf', 'leaf', 'leaf', 'leaf', 'fruit', 'fruit', 'leaf', 'bare'],
  persimmon: ['lastFruit', 'bare', 'bare', 'bare', 'leaf', 'leaf', 'leaf', 'leaf', 'leaf', 'leaf', 'fruit', 'lastFruit'],
  citron: ['fruit', 'leaf', 'leaf', 'leaf', 'leaf', 'blossom', 'leaf', 'leaf', 'leaf', 'leaf', 'fruit', 'fruit'],
  mulberry: ['bare', 'bare', 'bare', 'bare', 'leaf', 'leaf', 'fruit', 'leaf', 'leaf', 'leaf', 'leaf', 'bare'],
  pomegranate: ['bare', 'bare', 'bare', 'bare', 'leaf', 'leaf', 'blossom', 'blossom', 'leaf', 'fruit', 'fruit', 'bare'],
});

/** A tree kind as the plan draws it: its own motif for the two that have one, else a fruit tree of that kind. */
const treeChoice = (tree: TreeKind): Choice => (tree === 'mulberry' || tree === 'pomegranate' ? tree : kind('fruitTree', tree));

/** A branch's 물상, and what it gives: the island's season (as the month), the banks (as the year), the orchard's kind (as the hour). */
export type BranchImage = { image: string; season: Season; shore: ShoreKind; tree: TreeKind };

const WINTER_GRASS = ['#8f9470', '#9ea47e', '#808664', '#aeb38c'];
/**
 * Bare twigs in the snow months, grey-brown as a leafless crown looks from afar. Not white: under the village's warm
 * light a white crown reads as blossom, and the island would look like spring. The snow lies on the ground and roofs.
 */
const BARE_TWIGS = ['#8c8079', '#9a8f88', '#7d726c', '#a89e96'];

/**
 * By {@link BRANCHES}: 子 first. The orchard's kinds follow the months they are loveliest in: 子 동백, 丑 and 寅 매화,
 * 卯 살구, 辰 벚, 巳 앵두, 午 뽕(오디), 未 복숭아, 申 포도, 酉 석류, 戌 감, 亥 유자.
 */
const BRANCH_IMAGES: readonly BranchImage[] = frozen([
  {
    image: '한겨울 밤의 물',
    season: { branch: '子', key: 'winter', stage: 'mid', ko: '한겨울', leaves: BARE_TWIGS, foliage: 0.05, grass: WINTER_GRASS, blooms: ['#c8283a', '#d93a4a', '#ffffff', '#ffe066'], flowers: ['동백', '수선화'], falling: 'snow', cover: 'snow' },
    shore: 'pebbles',
    tree: 'camellia',
  },
  {
    image: '언 땅',
    season: { branch: '丑', key: 'winter', stage: 'late', ko: '늦겨울', leaves: BARE_TWIGS, foliage: 0.05, grass: WINTER_GRASS, blooms: ['#c8283a', '#ffffff', '#ffe066', '#fbe3ea'], flowers: ['동백', '수선화', '납매'], falling: 'snow', cover: 'snow' },
    shore: 'rocks',
    tree: 'plum',
  },
  {
    image: '초봄 숲',
    season: { branch: '寅', key: 'spring', stage: 'early', ko: '초봄', leaves: ['#c3dc8f', '#d2e6a4', '#b4d27e', '#e0edbd'], foliage: 0.15, grass: ['#92a85e', '#a0b46a', '#879d54', '#acbe78'], blooms: ['#ffffff', '#fbe3ea', '#ffd95a', '#d93a4a'], flowers: ['매화', '복수초', '동백'], falling: 'petals', cover: null },
    shore: 'ferns',
    tree: 'plum',
  },
  {
    image: '봄 풀꽃',
    season: { branch: '卯', key: 'spring', stage: 'mid', ko: '한봄', leaves: ['#b8d67e', '#c8e090', '#a8cc6c', '#d6e8a6'], foliage: 0.35, grass: ['#86ab54', '#95b85e', '#7a9f4a', '#a3c46a'], blooms: ['#ffd23f', '#f07aa8', '#ffffff', '#f9c4d4'], flowers: ['개나리', '진달래', '목련', '산수유'], falling: 'petals', cover: null },
    shore: 'flowers',
    tree: 'apricot',
  },
  {
    image: '봄 습지',
    season: { branch: '辰', key: 'spring', stage: 'late', ko: '늦봄', leaves: ['#a3cc68', '#b5d67a', '#8fbf5a', '#c2db8a'], foliage: 0.75, grass: ['#7fae4c', '#93bd58', '#6f9e42', '#a6c766'], blooms: ['#f9c4d4', '#ffe9f0', '#f48fb1', '#ffffff'], flowers: ['벚꽃', '복사꽃', '철쭉'], falling: 'petals', cover: null },
    shore: 'reeds',
    tree: 'cherry',
  },
  {
    image: '초여름 불',
    season: { branch: '巳', key: 'summer', stage: 'early', ko: '초여름', leaves: ['#6fa95a', '#7cb466', '#5f9a50', '#8abd72'], foliage: 1, grass: ['#5f8f3a', '#6f9f45', '#527f33', '#7fae4c'], blooms: ['#e8566a', '#ff8fa3', '#fff4ea', '#f7a8c4'], flowers: ['장미', '작약', '찔레꽃'], falling: null, cover: null },
    shore: 'sand',
    tree: 'nankingCherry',
  },
  {
    image: '한여름 해',
    season: { branch: '午', key: 'summer', stage: 'mid', ko: '한여름', leaves: ['#3f7a3c', '#4d8a45', '#366b36', '#5b9650'], foliage: 1, grass: ['#4f8a3c', '#5f9a48', '#447a34', '#6aa856'], blooms: ['#7f9cf0', '#b79cf0', '#f2894a', '#ff9fb5'], flowers: ['수국', '능소화', '접시꽃'], falling: null, cover: null },
    shore: 'sand',
    tree: 'mulberry',
  },
  {
    image: '여름 마른 땅',
    season: { branch: '未', key: 'summer', stage: 'late', ko: '늦여름', leaves: ['#4a7f3a', '#5a8f45', '#3f6f34', '#6a9a50'], foliage: 1, grass: ['#5f8a3c', '#6f9a45', '#527a34', '#80a84f'], blooms: ['#ffc21f', '#ff8a3d', '#ffb7d0', '#e8452f'], flowers: ['해바라기', '연꽃', '봉숭아'], falling: null, cover: null },
    shore: 'grass',
    tree: 'peach',
  },
  {
    image: '초가을 바위',
    season: { branch: '申', key: 'autumn', stage: 'early', ko: '초가을', leaves: ['#6f9a48', '#7fa850', '#8fae4f', '#5f8a40'], foliage: 1, grass: ['#7f9c47', '#8fa955', '#6e8b3c', '#a3b562'], blooms: ['#ffb7d0', '#ffffff', '#e86a9a', '#c9a0ff'], flowers: ['코스모스', '나팔꽃', '맨드라미'], falling: null, cover: null },
    shore: 'rocks',
    tree: 'grape',
  },
  {
    image: '가을 열매와 보석',
    season: { branch: '酉', key: 'autumn', stage: 'mid', ko: '한가을', leaves: ['#a8b85a', '#c9a84a', '#e0a83a', '#8fae4f'], foliage: 0.95, grass: ['#8f9a4a', '#a3a855', '#7f8a3e', '#b5b366'], blooms: ['#ffd95a', '#ffffff', '#c9a0ff', '#f2b84b'], flowers: ['국화', '구절초', '쑥부쟁이'], falling: 'leaves', cover: null },
    shore: 'pebbles',
    tree: 'pomegranate',
  },
  {
    image: '늦가을 마른 산',
    season: { branch: '戌', key: 'autumn', stage: 'late', ko: '늦가을', leaves: ['#c8452c', '#d95a2f', '#e08a2e', '#f2b84b'], foliage: 0.8, grass: ['#a39a55', '#b3a862', '#938a4a', '#c2b670'], blooms: ['#ffd95a', '#f3a53a', '#ffffff', '#d93a5a'], flowers: ['국화', '구절초', '산국'], falling: 'leaves', cover: null },
    shore: 'grass',
    tree: 'persimmon',
  },
  {
    image: '초겨울 바다',
    season: { branch: '亥', key: 'winter', stage: 'early', ko: '초겨울', leaves: ['#a8743a', '#b98a4a', '#c9a060', '#8f6a3a'], foliage: 0.3, grass: ['#9a9460', '#a8a06a', '#8a8456', '#b5ad78'], blooms: ['#d93a4a', '#ffffff', '#ffd95a', '#f7c6d4'], flowers: ['늦국화', '애기동백'], falling: 'leaves', cover: 'frost' },
    shore: 'shells',
    tree: 'citron',
  },
]);

/**
 * What the household hangs under its eaves or pastes on its door posts in each season, its first, middle and last
 * month: 입춘첩 at 입춘, the 씨오쟁이 of seed kept for the sowing, the swallows' nest when they come back at 삼짇날; a
 * blind for the first heat, 쑥 and 창포 at 단오, garlic plaited; corn, chillies, 곶감; 시래기 after the 김장, 메주, and
 * the 복조리 hung for the new year. The island's season says which three; the day branch's place in its own season
 * (孟·仲·季) says which of them.
 */
export const EAVES: Readonly<Record<Season['key'], readonly [Choice, Choice, Choice]>> = frozen({
  spring: ['ipchun', kind('drying', 'seeds'), 'swallowNest'],
  summer: ['blind', kind('drying', 'herbs'), kind('drying', 'garlic')],
  autumn: [kind('drying', 'corn'), kind('drying', 'peppers'), kind('drying', 'persimmons')],
  winter: [kind('drying', 'greens'), kind('drying', 'meju'), kind('drying', 'scoops')],
});

const STAGE_INDEX: Readonly<Record<Season['stage'], number>> = { early: 0, mid: 1, late: 2 };

/** The scene each of the sixty makes, its branch's 물상 the setting and its stem's the thing in it: 甲子 first. */
const SCENES: readonly string[] = frozen([
  '겨울 물가에 선 큰 나무', '언 땅 아래 잠든 꽃씨', '초봄 숲에 떠오르는 해', '봄 풀꽃 사이의 등불', '봄 습지 너머의 큰 산', '초여름 볕에 자라는 밭',
  '한여름 볕에 달군 무쇠', '마른 여름 땅에 묻힌 보석', '바위 사이로 흐르는 가을 강', '가을 열매에 맺힌 이슬', '늦가을 산마루의 큰 나무', '초겨울 바닷가의 들꽃',
  '동짓날 물 위로 뜨는 해', '언 땅을 비추는 작은 등불', '초봄 숲을 품은 큰 산', '봄 풀꽃이 핀 뜰', '봄 습지에 놓인 바위', '초여름 불빛에 빛나는 보석',
  '한여름 해 아래 흐르는 강', '마른 여름 땅에 내리는 단비', '바위에 뿌리내린 큰 나무', '가을 열매 곁에 핀 꽃', '늦가을 산 너머로 지는 해', '초겨울 바다를 비추는 등불',
  '겨울 밤 물가의 큰 산', '눈 덮인 겨울 밭', '초봄 숲 속의 바위', '봄 풀꽃에 내린 서리', '봄 습지로 흘러드는 강', '초여름 볕에 내리는 비',
  '한여름 해 아래 큰 나무', '마른 땅을 덮은 여름 덩굴', '초가을 바위산에 걸린 해', '가을 열매 곁의 등불', '단풍 든 늦가을 큰 산', '초겨울 바닷가의 밭',
  '겨울 밤 물에 잠긴 바위', '언 땅에 핀 서리꽃', '초봄 숲을 지나는 강', '봄 풀꽃에 맺힌 이슬', '봄 습지에 선 큰 나무', '초여름 볕에 핀 꽃',
  '한여름 한낮의 해', '여름 밤 마른 들의 별', '바위 많은 초가을 산', '가을 열매가 익은 밭', '늦가을 마른 산의 바위', '초겨울 바다에 씻긴 보석',
  '한겨울 밤의 깊은 바다', '언 땅에 내리는 겨울비', '초봄 숲의 큰 나무', '봄 들판 가득한 풀꽃', '봄 습지를 비추는 해', '초여름 밤에 타는 등불',
  '한여름 해 아래 큰 산', '여름 볕에 여문 밭', '초가을의 단단한 바위', '보석처럼 여문 가을 열매', '늦가을 산 아래 큰 바다', '초겨울 바다에 내리는 비',
]);

/** One of the sixty 간지 with its 물상. */
export type Ganji = {
  /** 0 甲子 … 59 癸亥. */
  index: number;
  /** `甲子`. */
  cn: string;
  /** `갑자`. */
  ko: string;
  stem: string;
  branch: string;
  nayin: Nayin;
  /** `큰 나무`, `한겨울 밤의 물`: what its stem and its branch are a picture of. */
  stemImage: string;
  branchImage: string;
  /** `겨울 물가에 선 큰 나무`: the scene the two make together (the 납음 draws its own picture beside it). */
  scene: string;
};

/** The sixty, 甲子 first. */
export const GANJI: readonly Ganji[] = frozen(
  Array.from({ length: 60 }, (_, index) => {
    const stem = STEMS[index % 10]!;
    const branch = BRANCHES[index % 12]!;
    return {
      index,
      cn: stem + branch,
      ko: hangulOf(stem) + hangulOf(branch),
      stem,
      branch,
      nayin: NAYINS[index >> 1]!,
      stemImage: STEM_IMAGES[index % 10]!.image,
      branchImage: BRANCH_IMAGES[index % 12]!.image,
      scene: SCENES[index]!,
    };
  }),
);

/**
 * The 간지 of a stem and a branch, or null when the two do not make one (a yang stem goes only with a yang branch). Its
 * place among the sixty is the one number below sixty that is the stem's place counted in tens and the branch's in
 * twelves: 6 × stem − 5 × branch, modulo 60.
 */
export function ganjiOf(stem: string, branch: string): Ganji | null {
  const s = STEMS.indexOf(stem);
  const b = BRANCHES.indexOf(branch);
  if (s < 0 || b < 0 || s % 2 !== b % 2) return null;
  return GANJI[(((6 * s - 5 * b) % 60) + 60) % 60] ?? null;
}

const stemImageOf = (ganji: Ganji) => STEM_IMAGES[ganji.index % 10]!;
const branchImageOf = (ganji: Ganji) => BRANCH_IMAGES[ganji.index % 12]!;
const seasonOfBranch = (branch: string): Season => BRANCH_IMAGES[BRANCHES.indexOf(branch)]!.season;

/** What the eaves hold on an island in `season` for a day branch `branch`: the season's hanging in the branch's 孟·仲·季. */
export const eavesOf = (season: Pick<Season, 'key'>, branch: string): Choice => EAVES[season.key][STAGE_INDEX[seasonOfBranch(branch).stage]]!;

/** How a tree of `tree` stands in the month of branch `month`. */
export const treeStateOf = (tree: TreeKind, month: string): TreeState => PHENOLOGY[tree][BRANCHES.indexOf(month)]!;

/** The small lives of an hour stem on an island in the month of branch `month`: its own in their months, else the birds that stay. */
export function creatureOf(stem: string, month: string): Creature {
  const own = STEM_IMAGES[STEMS.indexOf(stem)]!.creature;
  if (CREATURE_MONTHS[own].includes(month)) return own;
  return stemElement(stem) === 'metal' ? 'magpie' : 'sparrows';
}

/** A colour and the lighter and deeper ones that go with it. */
export type Tone = { main: string; light: string; deep: string };

/** 오방색 made soft for the village: 목 green, 화 coral, 토 yellow ochre, 금 pearl white, 수 indigo. */
export const TONES: Readonly<Record<Element, Readonly<Tone>>> = frozen({
  wood: { main: '#5fa36a', light: '#a8d8a0', deep: '#2f6b45' },
  fire: { main: '#e8644f', light: '#ffab96', deep: '#a8352a' },
  earth: { main: '#e0ab45', light: '#f6d68c', deep: '#9c6a26' },
  metal: { main: '#e4e6ea', light: '#ffffff', deep: '#a3abb6' },
  water: { main: '#4268b8', light: '#93b4f2', deep: '#25386f' },
});

/** The stone a house stands on, by the year stem's element: its name and the colours its blocks are laid in. */
export const STONES: Readonly<Record<Element, Readonly<{ name: string; colors: readonly string[] }>>> = frozen({
  wood: { name: '이끼 낀 자연석', colors: ['#a3ad92', '#959f84', '#b2bba2', '#8a947a'] },
  fire: { name: '붉은 사암', colors: ['#c9a291', '#b98f80', '#d6b3a3', '#ad8273'] },
  earth: { name: '누런 사암', colors: ['#d6c29c', '#c6af88', '#e0cfae', '#b9a27c'] },
  metal: { name: '흰 화강암', colors: ['#dcdad4', '#cbc8c1', '#e9e7e2', '#bfbcb5'] },
  water: { name: '푸른 청석', colors: ['#9aa4b1', '#8a95a3', '#aab3bf', '#7f8a98'] },
});

/** The door's colour, by the day stem's element, as the panel names it. */
export const DOOR_NAME: Readonly<Record<Element, string>> = frozen({ wood: '초록', fire: '다홍', earth: '황토색', metal: '흰', water: '남색' });

export type ShoeKind = 'clogs' | 'flowerShoes' | 'strawShoes' | 'whiteRubber' | 'blackRubber';

/** The shoes on the step stone before the door, by the hour stem's element: a grown-up pair, and a little pair beside it. */
export const SHOES: Readonly<Record<Element, Readonly<{ kind: ShoeKind; name: string; look: string }>>> = frozen({
  wood: { kind: 'clogs', name: '나막신', look: 'Wooden clogs on two teeth, a grown-up pair and a little pair beside it on the step stone (b.box soles, b.box teeth).' },
  fire: { kind: 'flowerShoes', name: '꽃신', look: 'Silk shoes in red and pink with flowers stitched on their toes, a grown-up pair and a little pair beside it on the step stone (b.dome toes, puff sprigs).' },
  earth: { kind: 'strawShoes', name: '짚신', look: 'Straw sandals woven loose, a grown-up pair and a little pair beside it on the step stone (b.box soles with straw-coloured cords).' },
  metal: { kind: 'whiteRubber', name: '흰 고무신', look: 'White rubber shoes with their toes turned up like a boat’s prow, a grown-up pair and a little pair beside it on the step stone (b.dome, glossy).' },
  water: { kind: 'blackRubber', name: '검정 고무신', look: 'Black rubber shoes with their toes turned up, a grown-up pair and a little pair beside it on the step stone (b.dome, glossy).' },
});

/**
 * What a day master's emblem already shows, which no pillar draws again beside it: 甲's great tree is a 당산나무 of its
 * own, 丙's sundial stands among sunflowers under a gilded sun, 癸's chain runs into a stone basin.
 */
export const EMBLEM_MOTIFS: Readonly<Record<YardSymbol, readonly MotifId[]>> = frozen({
  tree: ['oldTree'],
  trellis: ['flowerArch'],
  sun: ['sunflowers', 'sunDisc'],
  candle: ['candles'],
  mountain: ['rockHill'],
  field: ['vegetableRows'],
  anvil: ['brazier'],
  gem: ['crystals'],
  lighthouse: ['beacon'],
  rain: ['rainChain', 'spring'],
});

/**
 * What each house keeps of its own garden beside what the pillars draw, which they leave to it: the cabin's clearing,
 * the brick house's fire garden, the earth house's 장독대, 돌담 and 텃밭, the 기와집's court and its 풍경, the 연못집's
 * pond and well. The estate's layout places these (scene/estate STYLE_SPOT_OF), so it must follow what the yard keeps:
 * a house that gives one of these up hands it to the pillars. The trees behind a house are not among them: the 년주
 * stands there in their place.
 */
export const STYLE_MOTIFS: Readonly<Record<Element, readonly MotifId[]>> = frozen({
  wood: ['woodpile', 'mushrooms'],
  fire: ['bonfire', 'stringLights', 'clothesline', 'woodpile', 'pots'],
  earth: ['jars', 'stoneWall', 'vegetableRows', 'gourds', 'jige', 'stoneLamp'],
  metal: ['stoneLamp', 'stoneWall', 'windChime', 'birches', 'pines', 'bamboo'],
  water: ['pond', 'well', 'boat', 'willow', 'pots', 'irises'],
});

/**
 * What each house is built with of the catalogue's things (scene/houses: their parts), which no pillar stands beside
 * it again: the cabin's woodpile, the brick house's 화덕, the earth house's kiln and its onggi, the 기와집's wind bells
 * at the eaves' corners, the 연못집's 누마루 over the pond.
 */
export const HOUSE_MOTIFS: Readonly<Record<Element, readonly MotifId[]>> = frozen({
  wood: ['woodpile'],
  fire: ['hearth'],
  earth: ['kiln', 'jars'],
  metal: ['windChime'],
  water: ['pavilion'],
});

/** What the second element's keepsake is (yard.ts keepsake), which no pillar draws again beside it. */
export const KEEPSAKE_MOTIFS: Readonly<Record<Element, readonly MotifId[]>> = frozen({
  wood: ['bamboo'],
  fire: ['brazier'],
  earth: ['jars'],
  metal: ['windChime'],
  water: ['spring'],
});

/** Which of a pillar's characters called for a motif. */
export type Source = 'nayin' | 'stem' | 'branch';

/** A motif in its place on the island. */
export type Placed = {
  readonly motif: MotifId;
  readonly variant?: string;
  /** `곶감`, `버드나무`. */
  readonly name: string;
  readonly place: Place;
  readonly zone: Zone;
  readonly pillar: PillarKey;
  readonly from: Source;
  /** A tree that flowers and fruits, as it stands in the island's month. */
  readonly state?: TreeState;
  /** What its scatter is drawn by: the same for the same birth. */
  readonly seed: number;
};

/** What one pillar draws. */
export type PillarPlan = {
  readonly key: PillarKey;
  readonly role: Readonly<PillarRole>;
  readonly ganji: Ganji;
  /** The colours of its stem's element. */
  readonly tone: Readonly<Tone>;
  readonly motifs: readonly Placed[];
};

/** How the four pillars dress the house itself, one part each, from its foot to its door. */
export type Dress = {
  /** 년주 根: the stone of the plinth, the footings and the step, by the year stem's element. */
  readonly stone: { readonly element: Element; readonly name: string; readonly colors: readonly string[] };
  /** 월주 苗: what the house's pots and window boxes are in flower with: the month's flowers. */
  readonly flowers: { readonly names: readonly string[]; readonly colors: readonly string[] };
  /** 일주 花: the door's colour, by the day stem's element. */
  readonly door: { readonly element: Element; readonly name: string } & Readonly<Tone>;
  /** 시주 實: the shoes on the step, by the hour stem's element; none without an hour. */
  readonly shoes: { readonly element: Element; readonly kind: ShoeKind; readonly name: string } | null;
};

/** What a home's island draws of a chart, and where. */
export type IslandPlan = {
  /** The house, as before: built of the strongest element, the next element its accent (its keepsake), the day master's emblem by it. */
  readonly style: Element;
  readonly accent: Element | null;
  readonly emblem: YardSymbol;
  /** The month branch's: the island's foliage, grass, flowers and what falls, and the state of every tree and hanging. */
  readonly season: Readonly<Season>;
  /** The year branch's: how the banks are dressed. */
  readonly shore: ShoreKind;
  /** The month stem's: what the flower beds hold. */
  readonly beds: BedKind;
  /** The four pillars' parts of the house itself. */
  readonly dress: Dress;
  /** 년주 first; no hour for a birth without one. */
  readonly pillars: { readonly year: PillarPlan; readonly month: PillarPlan; readonly day: PillarPlan; readonly hour: PillarPlan | null };
  /** Every pillar's motifs, 년주's first (the house's choose first, but stand on the house and take no ground). */
  readonly motifs: readonly Placed[];
  readonly colors: { readonly house: Readonly<Tone>; readonly accent: Readonly<Tone> | null; readonly year: Readonly<Tone>; readonly month: Readonly<Tone>; readonly day: Readonly<Tone>; readonly hour: Readonly<Tone> | null };
  /** What the island's own scatter (its lawn, its beds) is drawn by. */
  readonly seed: number;
};

export type PlanOptions = {
  /** What the island holds already, beyond what the house, its yard, its emblem and its keepsake bring: no pillar draws it again. */
  taken?: Iterable<MotifId>;
  /**
   * The motifs the builders can draw. The plan is chosen with the whole catalogue first, and only a place whose choice
   * cannot be drawn yet takes its own next choice that can: a place whose choice can be drawn keeps it however the set
   * grows, and drawing one more motif moves the places that chose it (now and then another place that was waiting on
   * a stand-in too, as the stand-in it held comes free). Every motif when left out.
   */
  drawable?: ReadonlySet<MotifId>;
};

/** FNV-1a, folded to twenty bits: a Builder's seed stays exact when it is multiplied up into its stream. */
function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return ((hash >>> 0) % 0xfffff) + 1;
}

function ganjiOfPillar(pillar: Pillar): Ganji {
  const ganji = ganjiOf(pillar.stem, pillar.branch);
  if (!ganji) throw new Error(`not one of the sixty: ${pillar.stem}${pillar.branch}`);
  return ganji;
}

// A stem is always one of the ten.
const elementOfStem = (ganji: Ganji): Element => stemElement(ganji.stem) ?? 'earth';

const TREE_KINDS = new Set<string>(Object.keys(PHENOLOGY));

/** The kind of tree a choice is (the two tree motifs, a fruit tree, a pomegranate in its pot); null for anything else. */
function treeOf(choice: Choice): TreeKind | null {
  const motif = motifOf(choice);
  const variant = variantOf(choice);
  if (motif === 'mulberry' || motif === 'pomegranate') return motif;
  if (motif === 'bonsai' && variant === 'pomegranate') return 'pomegranate';
  if (motif === 'fruitTree' && variant !== undefined && TREE_KINDS.has(variant)) return variant as TreeKind;
  return null;
}

/** A pillar's plan while the places are being filled. */
type Building = { key: PillarKey; role: Readonly<PillarRole>; ganji: Ganji; tone: Readonly<Tone>; motifs: Placed[] };

/** One of a place's choices, with the character of its pillar that called for it. */
type Candidate = { choice: Choice; from: Source };

/** A place a pillar fills: its choices in order, where on the island they may stand, and whether it may repeat what stands elsewhere. */
type Slot = { pillar: Building; candidates: readonly Candidate[]; places: readonly Place[]; repeats: boolean };

/** A slot's choice: which candidate, and where it stands. */
type Chosen = { index: number; candidate: Candidate; place: Place };

const plans = new WeakMap<Reading, IslandPlan>();

/**
 * What a home's island draws of a reading, and where. The house chooses first, as the island's heart: the eaves take
 * the island season's hanging that the day branch's 孟·仲·季 points to, and the roof or the door the 일주's 납음. Then
 * the 년주's 납음 stands on the far land or a far bank, the 월주's in the garden, and the 시주 fills the front: the
 * orchard's kind (the 납음's own tree when it is one, else the hour branch's), one thing by the path and the hour
 * stem's small lives if they are about in the island's month. A motif already on the island (the house's own parts,
 * its yard, its emblem, its keepsake, an earlier pillar's) or one that does not suit the house is passed over for the
 * pillar's next choice; after its 납음's own choices come its element's ({@link ELEMENT_DRAWS}) and then plain ones
 * ({@link PLAIN_DRAWS}). Only the orchard may stand again what stands elsewhere (young trees in front of an old one).
 * Nothing in it changes with the day it is read on: one birth always gets the same island. What it hands out is
 * frozen, and the same object for the same reading.
 */
export function islandPlanOf(reading: Reading, options: PlanOptions = {}): IslandPlan {
  const cacheable = options.taken === undefined && options.drawable === undefined;
  if (cacheable) {
    const known = plans.get(reading);
    if (known) return known;
  }
  const { house } = profileOfReading(reading);
  const style = house.style;
  const kept = new Set<MotifId>([
    ...EMBLEM_MOTIFS[house.symbol],
    ...STYLE_MOTIFS[style],
    ...HOUSE_MOTIFS[style],
    ...(house.accent ? KEEPSAKE_MOTIFS[house.accent] : []),
    ...(options.taken ?? []),
  ]);

  const start = (key: PillarKey, pillar: Pillar): Building => {
    const ganji = ganjiOfPillar(pillar);
    return { key, role: PILLAR_ROLES[key], ganji, tone: TONES[elementOfStem(ganji)], motifs: [] };
  };
  const year = start('year', reading.year);
  const month = start('month', reading.month);
  const day = start('day', reading.day);
  const hour = reading.hour ? start('hour', reading.hour) : null;
  const season = branchImageOf(month.ganji).season;

  const nayinCandidates = (plan: Building): Candidate[] => {
    const { zone } = plan.role;
    const { draws, element } = plan.ganji.nayin;
    return [...draws[zone], ...ELEMENT_DRAWS[element][zone], ...PLAIN_DRAWS[zone]].map((choice) => ({ choice, from: 'nayin' }));
  };
  const slots: Slot[] = [
    // 일: what the household hangs in the island's season, then the roof or the door.
    {
      pillar: day,
      candidates: [0, 1, 2].map((step) => ({ choice: EAVES[season.key][(STAGE_INDEX[seasonOfBranch(day.ganji.branch).stage] + step) % 3]!, from: 'branch' })),
      places: ['eaves'],
      repeats: false,
    },
    { pillar: day, candidates: nayinCandidates(day), places: ['roof', 'front'], repeats: false },
    // 년: the far land or a far bank. 월: the garden.
    { pillar: year, candidates: nayinCandidates(year), places: ['back', 'shore'], repeats: false },
    { pillar: month, candidates: nayinCandidates(month), places: ['side'], repeats: false },
  ];
  if (hour) {
    // 시: the orchard's kind, the 납음's own tree when it is one, else the hour branch's.
    const own = hour.ganji.nayin.draws.details.find((choice) => MOTIFS[motifOf(choice)].places.includes('corner'));
    const orchard: Candidate[] = [...(own ? [{ choice: own, from: 'nayin' as const }] : []), { choice: treeChoice(branchImageOf(hour.ganji).tree), from: 'branch' }];
    slots.push(
      { pillar: hour, candidates: orchard, places: ['corner'], repeats: true },
      { pillar: hour, candidates: nayinCandidates(hour), places: ['path'], repeats: false },
      {
        pillar: hour,
        candidates: [...new Set<Creature>([creatureOf(hour.ganji.stem, season.branch), 'sparrows'])].map((creature) => ({ choice: creature, from: 'stem' })),
        places: ['life'],
        repeats: false,
      },
    );
  }

  /** The first of `slot`'s candidates from `from` on that suits the house, has a place here and is not `held`. */
  const pickOf = (slot: Slot, from: number, allowed: (motif: MotifId) => boolean): Chosen | null => {
    for (let index = from; index < slot.candidates.length; index++) {
      const candidate = slot.candidates[index]!;
      const motif = motifOf(candidate.choice);
      if (!allowed(motif) || !suits(motif, style)) continue;
      const place = slot.places.find((at) => MOTIFS[motif].places.includes(at));
      if (place) return { index, candidate, place };
    }
    return null;
  };

  // With the whole catalogue first: each place in turn takes its first choice that nothing before it holds.
  const held = new Set(kept);
  const full = slots.map((slot) => {
    const pick = pickOf(slot, 0, (motif) => slot.repeats || !held.has(motif));
    if (pick) held.add(motifOf(pick.candidate.choice));
    return pick;
  });
  // Then a place whose choice cannot be drawn yet takes its own next one that can, clear of everything chosen above.
  const drawable = options.drawable;
  const chosen = drawable
    ? full.map((pick, index) => {
        if (!pick || drawable.has(motifOf(pick.candidate.choice))) return pick;
        const slot = slots[index]!;
        const next = pickOf(slot, pick.index + 1, (motif) => drawable.has(motif) && (slot.repeats || !held.has(motif)));
        if (next) held.add(motifOf(next.candidate.choice));
        return next;
      })
    : full;

  chosen.forEach((pick, index) => {
    if (!pick) return;
    const plan = slots[index]!.pillar;
    const { choice, from } = pick.candidate;
    const motif = motifOf(choice);
    const variant = variantOf(choice);
    const tree = treeOf(choice);
    const placed: Placed = {
      motif,
      ...(variant !== undefined ? { variant } : {}),
      name: motifName(motif, variant),
      place: pick.place,
      zone: plan.role.zone,
      pillar: plan.key,
      from,
      ...(tree ? { state: treeStateOf(tree, season.branch) } : {}),
      seed: seedOf(`${plan.ganji.index}:${plan.key}:${motif}:${variant ?? ''}`),
    };
    plan.motifs.push(placed);
  });

  const yearElement = elementOfStem(year.ganji);
  const dayElement = elementOfStem(day.ganji);
  const hourElement = hour ? elementOfStem(hour.ganji) : null;
  const plan: IslandPlan = {
    style,
    accent: house.accent,
    emblem: house.symbol,
    season,
    shore: branchImageOf(year.ganji).shore,
    beds: stemImageOf(month.ganji).beds,
    dress: {
      stone: { element: yearElement, ...STONES[yearElement] },
      flowers: { names: season.flowers, colors: season.blooms },
      door: { element: dayElement, name: DOOR_NAME[dayElement], ...TONES[dayElement] },
      shoes: hourElement ? { element: hourElement, kind: SHOES[hourElement].kind, name: SHOES[hourElement].name } : null,
    },
    pillars: { year, month, day, hour },
    motifs: [year, month, day, hour].flatMap((pillar) => pillar?.motifs ?? []),
    colors: {
      house: TONES[style],
      accent: house.accent ? TONES[house.accent] : null,
      year: year.tone,
      month: month.tone,
      day: day.tone,
      hour: hour?.tone ?? null,
    },
    seed: seedOf([year, month, day].map((pillar) => pillar.ganji.index).join(':') + `:${hour?.ganji.index ?? 60}`),
  };
  frozen(plan);
  if (cacheable) plans.set(reading, plan);
  return plan;
}

/** What a 간지's stem and branch give the island, for what reads the tables whole (a panel, a test). */
export function imagesOf(ganji: Ganji): { stem: StemImage; branch: BranchImage } {
  return { stem: stemImageOf(ganji), branch: branchImageOf(ganji) };
}
