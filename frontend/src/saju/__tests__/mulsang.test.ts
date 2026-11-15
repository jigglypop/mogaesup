import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { BRANCHES, branchElement, ELEMENT_NAME, ELEMENTS, hangulOf, STEMS, stemElement, type Element } from '../elements';
import { pillarsOf, readingOf, type Pillar, type Reading } from '../engine';
import { nayinKo } from '../labels';
import { LONG_PLACES, MOTIF_IDS, MOTIFS, PLACE_NAME, PLACE_REACH, suits, ZONE_NAME, ZONE_PLACES, type MotifId, type Place, type Zone } from '../motifs';
import {
  creatureOf,
  EAVES,
  eavesOf,
  ELEMENT_DRAWS,
  EMBLEM_MOTIFS,
  GANJI,
  ganjiOf,
  HOUSE_MOTIFS,
  imagesOf,
  islandPlanOf,
  KEEPSAKE_MOTIFS,
  NAYINS,
  PHENOLOGY,
  PILLAR_ROLES,
  PLAIN_DRAWS,
  SHOES,
  STONES,
  STYLE_MOTIFS,
  TONES,
  treeStateOf,
  type Choice,
  type Ganji,
  type IslandPlan,
  type TreeKind,
} from '../mulsang';
import { rng } from '../scene/noise';
import { PEOPLE, personOf } from './people';

const ZONES: readonly Zone[] = ['land', 'garden', 'house', 'details'];
/** Where a pillar's 납음 may put what it draws: the eaves are the day branch's, the life the hour stem's. */
const NAYIN_PLACES: Record<Zone, readonly Place[]> = { land: ['back', 'shore'], garden: ['side'], house: ['roof', 'front'], details: ['corner', 'path'] };
/** The places that stand on the ground, as against on the house or in the air. */
const GROUND: readonly Place[] = ['back', 'shore', 'side', 'corner', 'path'];
const SNOW_MONTHS = '亥子丑';
const HANGUL = /^[가-힣 ]+$/;

const motifOf = (choice: Choice) => (typeof choice === 'string' ? choice : choice.motif);
const variantOf = (choice: Choice) => (typeof choice === 'string' ? undefined : choice.variant);
const keyOf = (choice: Choice) => `${motifOf(choice)}:${variantOf(choice) ?? ''}`;
const treeChoice = (tree: TreeKind): Choice => (tree === 'mulberry' || tree === 'pomegranate' ? tree : { motif: 'fruitTree', variant: tree });

/** Every motif any table asks for, with the kind it asks for. */
function everyChoice(): Choice[] {
  const choices: Choice[] = [];
  for (const nayin of NAYINS) for (const zone of ZONES) choices.push(...nayin.draws[zone]);
  for (const draws of Object.values(ELEMENT_DRAWS)) for (const zone of ZONES) choices.push(...draws[zone]);
  for (const zone of ZONES) choices.push(...PLAIN_DRAWS[zone]);
  for (const hangings of Object.values(EAVES)) choices.push(...hangings);
  for (const ganji of GANJI) {
    const { stem, branch } = imagesOf(ganji);
    choices.push(treeChoice(branch.tree), stem.creature);
  }
  choices.push('sparrows', 'magpie');
  return choices;
}

/** One of the sixty standing in a real pillar's place: the plan reads its characters, its elements and its 납음. */
function standIn(base: Pillar, ganji: Ganji): Pillar {
  const element = (character: string, of: (character: string) => keyof typeof ELEMENT_NAME | null) => ELEMENT_NAME[of(character)!].hanja;
  return {
    ...base,
    cn: ganji.cn,
    ko: ganji.ko,
    stem: ganji.stem,
    branch: ganji.branch,
    stemKo: hangulOf(ganji.stem),
    branchKo: hangulOf(ganji.branch),
    wuxing: element(ganji.stem, stemElement) + element(ganji.branch, branchElement),
    nayin: ganji.nayin.cn,
  };
}

/** Each of the sixty in each pillar of one chart, the others as they are, and charts of four at random, one in five without its hour. */
function manyReadings(count: number): Reading[] {
  const base = readingOf(personOf('sol').birth);
  const readings: Reading[] = [];
  for (const ganji of GANJI) {
    readings.push({ ...base, year: standIn(base.year, ganji) }, { ...base, month: standIn(base.month, ganji) }, { ...base, day: standIn(base.day, ganji) }, { ...base, hour: standIn(base.hour!, ganji) });
  }
  const random = rng(19);
  const any = () => GANJI[Math.floor(random() * 60)]!;
  for (let index = 0; index < count; index++) {
    readings.push({ ...base, year: standIn(base.year, any()), month: standIn(base.month, any()), day: standIn(base.day, any()), hour: index % 5 === 0 ? null : standIn(base.hour!, any()) });
  }
  return readings;
}

const lines = (plan: IslandPlan) => plan.motifs.map((item) => `${item.pillar} ${item.place} ${item.name}${item.state ? ` (${item.state})` : ''}`);
const treeOfPlaced = (item: IslandPlan['motifs'][number]): TreeKind | null =>
  item.motif === 'fruitTree' ? (item.variant as TreeKind) : item.motif === 'mulberry' || item.motif === 'pomegranate' ? item.motif : item.motif === 'bonsai' && item.variant === 'pomegranate' ? 'pomegranate' : null;

describe('육십갑자의 물상', () => {
  it('육십갑자가 차례대로 한 번씩 있다', () => {
    expect(GANJI).toHaveLength(60);
    expect(new Set(GANJI.map((ganji) => ganji.cn)).size).toBe(60);
    GANJI.forEach((ganji, index) => {
      expect(ganji.index).toBe(index);
      expect(ganji.cn).toBe(STEMS[index % 10]! + BRANCHES[index % 12]!);
      expect(ganjiOf(ganji.stem, ganji.branch)).toBe(ganji);
    });
    expect(GANJI[0]!.ko).toBe('갑자');
    expect(GANJI[59]!.cn).toBe('癸亥');
    // A yang stem never meets a yin branch.
    expect(ganjiOf('甲', '丑')).toBeNull();
    expect(ganjiOf('木', '子')).toBeNull();
  });

  it('납음 서른 가지는 jamiblossom의 표, labels.ts의 한글과 같고, 두 간지씩 짝을 이룬다', () => {
    const { LunarUtil } = createRequire(import.meta.resolve('jamiblossom'))('lunar-javascript') as { LunarUtil: { NAYIN: Record<string, string> } };
    for (const ganji of GANJI) expect(ganji.nayin.cn).toBe(LunarUtil.NAYIN[ganji.cn]);
    for (const nayin of NAYINS) expect(nayinKo(nayin.cn)).toBe(nayin.ko);
    for (let pair = 0; pair < 30; pair++) expect(GANJI[pair * 2]!.nayin).toBe(GANJI[pair * 2 + 1]!.nayin);
    expect(NAYINS.map((nayin) => nayin.ko).join(' ')).toBe(
      '해중금 노중화 대림목 노방토 검봉금 산두화 간하수 성두토 백랍금 양류목 천중수 옥상토 벽력화 송백목 장류수 사중금 산하화 평지목 벽상토 금박금 복등화 천하수 대역토 차천금 상자목 대계수 사중토 천상화 석류목 대해수',
    );
    // The Korean spellings, as 三命通會 and Korean almanacs write them (泉中水 is also written 井泉水).
    expect(NAYINS.map((nayin) => nayin.hanja).join(' ')).toBe(
      '海中金 爐中火 大林木 路傍土 劍鋒金 山頭火 澗下水 城頭土 白蠟金 楊柳木 泉中水 屋上土 霹靂火 松柏木 長流水 沙中金 山下火 平地木 壁上土 金箔金 覆燈火 天河水 大驛土 釵釧金 桑柘木 大溪水 沙中土 天上火 石榴木 大海水',
    );
    expect(NAYINS.map((nayin) => ELEMENT_NAME[nayin.element].hanja).join('')).toBe(NAYINS.map((nayin) => nayin.hanja.slice(-1)).join(''));
  });

  it('사주가 읽은 납음이 표와 같다', () => {
    // Sixty days running: the day pillar comes round all sixty.
    const seen = new Set<string>();
    for (let day = 1; day <= 60; day++) {
      const date = new Date(Date.UTC(1990, 0, day));
      const reading = readingOf({ calendar: 'solar', year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), leapMonth: false, time: '12:00', gender: 'female' });
      for (const { pillar } of pillarsOf(reading)) {
        expect(ganjiOf(pillar.stem, pillar.branch)!.nayin.cn).toBe(pillar.nayin);
        seen.add(pillar.cn);
      }
    }
    expect(seen.size).toBe(60);
    // Sixty charts: jamiblossom draws the whole 자미두수 chart for each, which a busy runner takes its time over.
  }, 60_000);

  it('천간과 지지의 물상, 둘이 만드는 장면', () => {
    expect(GANJI.slice(0, 10).map((ganji) => ganji.stemImage)).toEqual(['큰 나무', '화초와 덩굴', '태양', '등불과 별', '큰 산', '논밭과 정원', '바위와 무쇠', '보석과 서리', '바다와 큰 강', '비와 이슬']);
    expect(GANJI.slice(0, 12).map((ganji) => ganji.branchImage)).toEqual([
      '한겨울 밤의 물', '언 땅', '초봄 숲', '봄 풀꽃', '봄 습지', '초여름 불', '한여름 해', '여름 마른 땅', '초가을 바위', '가을 열매와 보석', '늦가을 마른 산', '초겨울 바다',
    ]);
    for (const ganji of GANJI) {
      expect(ganji.stemImage).toBe(GANJI[ganji.index % 10]!.stemImage);
      expect(ganji.branchImage).toBe(GANJI[ganji.index % 12]!.branchImage);
      expect(ganji.scene).toMatch(HANGUL);
      expect(ganji.nayin.image).toMatch(HANGUL);
    }
    expect(new Set(GANJI.map((ganji) => ganji.scene)).size).toBe(60);
    expect(GANJI[0]!.scene).toBe('겨울 물가에 선 큰 나무');
  });
});

describe('한 섬에 계절 하나', () => {
  it('달의 지지가 계절을 정한다: 寅 초봄부터 丑 늦겨울까지, 孟·仲·季', () => {
    const seasonOf = (branch: string) => imagesOf(GANJI.find((ganji) => ganji.branch === branch)!).branch.season;
    expect([...'寅卯辰巳午未申酉戌亥子丑'].map((branch) => seasonOf(branch).ko)).toEqual(['초봄', '한봄', '늦봄', '초여름', '한여름', '늦여름', '초가을', '한가을', '늦가을', '초겨울', '한겨울', '늦겨울']);
    expect([...'寅卯辰巳午未申酉戌亥子丑'].map((branch) => seasonOf(branch).stage)).toEqual(['early', 'mid', 'late', 'early', 'mid', 'late', 'early', 'mid', 'late', 'early', 'mid', 'late']);
    for (const branch of BRANCHES) expect(seasonOf(branch).branch).toBe(branch);
    // Early spring in Korea is bare boughs in blossom, the green coming in 卯 and 辰.
    expect(seasonOf('寅').foliage).toBeLessThanOrEqual(0.2);
    expect(seasonOf('卯').foliage).toBeLessThanOrEqual(0.4);
    // What is named as in flower is a flower.
    for (const branch of BRANCHES) for (const name of seasonOf(branch).flowers) expect(['억새', '단풍', '봉오리'].some((word) => name.includes(word)), name).toBe(false);
    // Snow lies where snow falls.
    for (const branch of BRANCHES) expect(seasonOf(branch).falling === 'snow').toBe(seasonOf(branch).cover === 'snow');
  });

  it('처마에는 섬의 계절에 거는 것을 걸고, 일지의 孟·仲·季가 그중 하나를 고른다', () => {
    for (const [season, hangings] of Object.entries(EAVES)) {
      expect(hangings, season).toHaveLength(3);
      for (const choice of hangings) expect(MOTIFS[motifOf(choice)].places).toContain('eaves');
    }
    expect(Object.values(EAVES).flat().map(keyOf)).toHaveLength(new Set(Object.values(EAVES).flat().map(keyOf)).size);
    // 寅 is a season's first month, 卯 its middle, 辰 its last, whatever season the island is in.
    expect([...'寅卯辰'].map((branch) => keyOf(eavesOf({ key: 'winter' }, branch)))).toEqual(['drying:greens', 'drying:meju', 'drying:scoops']);
    expect([...'申酉戌'].map((branch) => keyOf(eavesOf({ key: 'spring' }, branch)))).toEqual(['ipchun:', 'drying:seeds', 'swallowNest:']);
  });

  it('나무는 섬의 달에 제 종류가 하는 모습으로 선다', () => {
    for (const [tree, states] of Object.entries(PHENOLOGY) as [TreeKind, readonly string[]][]) {
      expect(states, tree).toHaveLength(12);
      // The grape, the persimmon and the mulberry flower too small to see from the village's height.
      if (!['grape', 'persimmon', 'mulberry'].includes(tree)) expect(states, tree).toContain('blossom');
      if (tree !== 'camellia') expect(states, tree).toContain('fruit');
      // Nothing blossoms under the snow but the camellia, which flowers in winter.
      for (const branch of SNOW_MONTHS) if (tree !== 'camellia') expect(treeStateOf(tree, branch), `${tree} ${branch}`).not.toBe('blossom');
      // Nothing is in fruit while spring flowers but the citron, which keeps its fruit into the new year.
      for (const branch of '寅卯辰') if (tree !== 'citron') expect(treeStateOf(tree, branch), `${tree} ${branch}`).not.toBe('fruit');
    }
    // A bud is a deciduous tree's the month before it flowers; the evergreens are never bare.
    for (const [tree, states] of Object.entries(PHENOLOGY)) states.forEach((state, index) => state === 'bud' && expect(states[(index + 1) % 12], tree).toBe('blossom'));
    for (const tree of ['camellia', 'citron'] as const) for (const state of ['bare', 'bud'] as const) expect(PHENOLOGY[tree]).not.toContain(state);
    expect(treeStateOf('persimmon', '亥')).toBe('lastFruit');
    expect(treeStateOf('plum', '寅')).toBe('blossom');
  });

  it('작은 생명은 섬의 달에 나와 있는 것이다', () => {
    for (const stem of STEMS) {
      for (const branch of BRANCHES) {
        const creature = creatureOf(stem, branch);
        expect(MOTIFS[creature].places).toContain('life');
        if (SNOW_MONTHS.includes(branch)) expect(['ducks', 'sparrows', 'magpie'], `${stem} ${branch}`).toContain(creature);
      }
    }
    expect(creatureOf('甲', '午')).toBe('butterflies');
    expect(creatureOf('甲', '子')).toBe('sparrows');
    expect(creatureOf('庚', '子')).toBe('magpie');
    expect(creatureOf('壬', '子')).toBe('ducks');
  });
});

describe('그릴 것의 목록', () => {
  it('표가 부르는 것은 모두 목록에 있고, 그 종류도 목록에 있다', () => {
    for (const choice of everyChoice()) {
      expect(MOTIF_IDS).toContain(motifOf(choice));
      const variant = variantOf(choice);
      if (variant !== undefined) expect(Object.keys(MOTIFS[motifOf(choice)].variants ?? {})).toContain(variant);
    }
    for (const table of [EMBLEM_MOTIFS, STYLE_MOTIFS, HOUSE_MOTIFS, KEEPSAKE_MOTIFS]) for (const motifs of Object.values(table)) for (const motif of motifs) expect(MOTIF_IDS).toContain(motif);
  });

  it('목록의 것은 모두, 종류마다, 어느 표에서든 불린다', () => {
    const asked = new Set(everyChoice().map(keyOf));
    for (const motif of MOTIF_IDS) {
      expect([...asked].some((key) => key.startsWith(`${motif}:`)), motif).toBe(true);
      for (const variant of Object.keys(MOTIFS[motif].variants ?? {})) expect(asked.has(`${motif}:${variant}`), `${motif}:${variant}`).toBe(true);
    }
  });

  it('목록의 것은 저마다 이름과 모습, 놓일 곳이 있고, 그 자리에 맞는 크기다', () => {
    const places = new Set(Object.values(ZONE_PLACES).flat());
    for (const place of places) expect(PLACE_NAME[place]).toMatch(HANGUL);
    for (const zone of ZONES) expect(ZONE_NAME[zone]).toMatch(HANGUL);
    for (const motif of MOTIF_IDS) {
      const entry = MOTIFS[motif];
      expect(entry.ko).toMatch(HANGUL);
      expect(entry.look.length).toBeGreaterThan(20);
      expect(entry.reach).toBeGreaterThan(0);
      expect(entry.places.length).toBeGreaterThan(0);
      for (const place of entry.places) {
        expect(places.has(place)).toBe(true);
        // What is laid along a line keeps to the far edges and the garden; everything else to its place's reach.
        if (entry.long) expect(LONG_PLACES, `${motif} ${place}`).toContain(place);
        else expect(entry.reach, `${motif} ${place}`).toBeLessThanOrEqual(PLACE_REACH[place]);
      }
      for (const name of Object.values(entry.variants ?? {})) expect(name).toMatch(HANGUL);
      for (const style of entry.fits ?? []) expect(ELEMENTS).toContain(style);
    }
  });

  it('납음마다 네 구역 모두에 둘 것이 둘 이상 있고, 모두 그 구역에 놓일 수 있다', () => {
    for (const nayin of NAYINS) {
      for (const zone of ZONES) {
        const choices = nayin.draws[zone];
        expect(choices.length, `${nayin.ko} ${zone}`).toBeGreaterThanOrEqual(2);
        for (const choice of choices) expect(MOTIFS[motifOf(choice)].places.some((place) => NAYIN_PLACES[zone].includes(place)), `${nayin.ko} ${zone} ${motifOf(choice)}`).toBe(true);
      }
      // The path always has something of it; the corner only a fruit tree of its own.
      expect(nayin.draws.details.some((choice) => MOTIFS[motifOf(choice)].places.includes('path'))).toBe(true);
    }
    for (const draws of [...Object.values(ELEMENT_DRAWS), PLAIN_DRAWS]) {
      for (const zone of ZONES) for (const choice of draws[zone]) expect(MOTIFS[motifOf(choice)].places.some((place) => NAYIN_PLACES[zone].includes(place))).toBe(true);
    }
    // No two 납음 dress the house with the same first thing.
    expect(new Set(NAYINS.map((nayin) => keyOf(nayin.draws.house[0]!))).size).toBe(30);
  });

  it('어느 집에도 맞는 지붕·문간 것이 맨 뒤에 있다', () => {
    for (const style of ELEMENTS) expect(PLAIN_DRAWS.house.some((choice) => suits(motifOf(choice), style)), style).toBe(true);
    expect(suits('lightningRod', 'metal')).toBe(false);
    expect(suits('gourds', 'wood')).toBe(true);
  });
});

describe('섬의 계획', () => {
  it('네 기둥은 근묘화실을 따라 집의 아래에서 문까지, 섬의 먼 쪽에서 앞으로 놓인다', () => {
    expect(Object.fromEntries(Object.entries(PILLAR_ROLES).map(([key, role]) => [key, `${role.hanja} ${role.ko} ${role.zone} ${role.dresses}`]))).toEqual({
      year: '根 뿌리 land stone',
      month: '苗 싹 garden flowers',
      day: '花 꽃 house door',
      hour: '實 열매 details shoes',
    });
    for (const role of Object.values(PILLAR_ROLES)) for (const text of [role.stands, role.house, role.island]) expect(text).toMatch(/^[가-힣 ,]+$/);
    for (const resident of PEOPLE) {
      const plan = islandPlanOf(readingOf(resident.birth));
      for (const item of plan.motifs) {
        expect(item.zone).toBe(PILLAR_ROLES[item.pillar].zone);
        expect(ZONE_PLACES[item.zone]).toContain(item.place);
        expect(MOTIFS[item.motif].places).toContain(item.place);
      }
    }
  });

  it('네 사람의 섬', () => {
    const plan = (id: string) => islandPlanOf(readingOf(personOf(id).birth));
    // 솔 己巳 丙寅 甲寅 乙亥, 초봄의 오두막: 甲 상징물이 큰 나무라 대림목은 숲 가장자리, 일지 寅(孟)이 봄의 입춘첩을, 시지 亥가 유자나무를 고르고, 乙의 나비는 아직 나오지 않아 참새가 논다.
    expect(lines(plan('sol'))).toEqual(['year back 숲 가장자리', 'month side 아궁이와 가마솥', 'day eaves 입춘첩', 'day front 물항아리', 'hour corner 유자나무 (leaf)', 'hour path 초롱 줄등', 'hour life 참새']);
    expect(plan('sol')).toMatchObject({ style: 'wood', emblem: 'tree', shore: 'sand', beds: 'tall', season: { ko: '초봄', falling: 'petals' } });
    expect(plan('sol').dress).toMatchObject({ stone: { name: '누런 사암' }, flowers: { names: ['매화', '복수초', '동백'] }, door: { name: '초록' }, shoes: { name: '나막신' } });
    // 노을 丁卯 丙午 丁酉 甲辰, 한여름의 벽돌집: 단오의 쑥과 창포, 丁의 촛불이 등잔을 가져 산하화는 청사초롱, 복등화의 청사초롱은 일주가 먼저 가져 석등.
    expect(lines(plan('noeul'))).toEqual(['year back 옹기 가마', 'month side 꼬마 비구름', 'day eaves 쑥과 창포 다발', 'day front 청사초롱', 'hour corner 벚나무 (leaf)', 'hour path 석등', 'hour life 나비']);
    expect(plan('noeul')).toMatchObject({ style: 'fire', emblem: 'candle', shore: 'flowers', season: { ko: '한여름' } });
    // 보리 戊辰 辛酉 己丑 丙寅, 한가을의 황토집: 대림목의 당산나무, 피뢰침과 풍향계가 이 집에 맞지 않아 벽력화는 화의 청사초롱을 건다. 석류는 제철 열매다.
    expect(lines(plan('bori'))).toEqual(['year back 당산나무', 'month side 석류나무 (fruit)', 'day eaves 곶감', 'day front 청사초롱', 'hour corner 매화나무 (leaf)', 'hour path 등잔불', 'hour life 참새']);
    expect(plan('bori')).toMatchObject({ style: 'earth', emblem: 'field', shore: 'reeds', beds: 'gravel', season: { ko: '한가을', falling: 'leaves' } });
    // 가람 壬申 辛亥 壬辰 壬寅, 초겨울의 연못집: 섣달의 복조리, 장류수의 빗물 사슬, 서리 내린 맨가지 매화, 겨울에도 물 위의 오리.
    expect(lines(plan('garam'))).toEqual(['year back 선돌', 'month side 꽃 아치', 'day eaves 복조리', 'day roof 빗물 사슬', 'hour corner 매화나무 (bare)', 'hour path 꼬마전구 줄등', 'hour life 오리']);
    expect(plan('garam')).toMatchObject({ style: 'water', emblem: 'lighthouse', shore: 'rocks', season: { ko: '초겨울', cover: 'frost' } });
    expect(plan('garam').colors).toMatchObject({ year: { main: '#4268b8' }, month: { main: '#e4e6ea' }, house: { main: '#4268b8' }, accent: { main: '#e4e6ea' } });
    expect(plan('garam').dress).toMatchObject({ stone: { name: '푸른 청석', colors: STONES.water.colors }, door: { element: 'water', main: TONES.water.main }, shoes: { kind: 'blackRubber', name: '검정 고무신' } });
  });

  it('한 생일은 언제나 같은 섬이 되고, 그 섬은 누구도 고칠 수 없다', () => {
    for (const resident of PEOPLE) {
      const reading = readingOf(resident.birth);
      const plan = islandPlanOf(reading);
      expect(islandPlanOf(reading)).toBe(plan);
      // A reading drawn again (a new object, or a page left open into the next day) makes the same island.
      expect(islandPlanOf({ ...reading, currentDaYun: null })).toEqual(plan);
      expect(Object.isFrozen(plan) && Object.isFrozen(plan.motifs) && Object.isFrozen(plan.season) && Object.isFrozen(plan.colors.house) && Object.isFrozen(plan.dress.stone.colors)).toBe(true);
      expect(() => (plan.motifs as IslandPlan['motifs'][number][]).reverse()).toThrow(TypeError);
      expect(() => ((plan.season.leaves as string[])[0] = '#000000')).toThrow(TypeError);
      expect(islandPlanOf(reading).motifs[0]!.pillar).toBe('year');
    }
    expect(Object.isFrozen(NAYINS[0]!.draws.land) && Object.isFrozen(GANJI[0]) && Object.isFrozen(MOTIFS.pines.places) && Object.isFrozen(PHENOLOGY.plum)).toBe(true);
    const seeds = PEOPLE.map((resident) => islandPlanOf(readingOf(resident.birth)).seed);
    expect(new Set(seeds).size).toBe(4);
  });

  it('시를 모르면 시주의 것은 그리지 않고, 나머지는 그대로 그린다', () => {
    for (const resident of PEOPLE) {
      const known = islandPlanOf(readingOf(resident.birth));
      const unknown = islandPlanOf(readingOf({ ...resident.birth, time: null }));
      expect(unknown.pillars.hour).toBeNull();
      expect(unknown.colors.hour).toBeNull();
      expect(unknown.dress.shoes).toBeNull();
      expect(unknown.motifs.some((item) => item.zone === 'details')).toBe(false);
      expect(unknown.season).toEqual(known.season);
      expect(unknown.motifs.filter((item) => item.zone !== 'details')).toHaveLength(4);
    }
    expect(lines(islandPlanOf(readingOf({ ...personOf('sol').birth, time: null })))).toEqual(['year back 숲 가장자리', 'month side 아궁이와 가마솥', 'day eaves 입춘첩', 'day front 물항아리']);
  });

  it('어느 사주든 계절 하나, 집에 맞는 것, 겹치지 않는 것, 넷 안팎의 것을 그린다', () => {
    let ground = 0;
    const readings = manyReadings(3000);
    for (const reading of readings) {
      const plan = islandPlanOf(reading);
      const others = plan.motifs.filter((item) => item.place !== 'corner').map((item) => item.motif);
      expect(new Set(others).size).toBe(others.length);
      // Nothing the house, its yard, its emblem or its keepsake shows is drawn again beside it, and nothing that does not suit it.
      const kept = new Set<MotifId>([...STYLE_MOTIFS[plan.style], ...HOUSE_MOTIFS[plan.style], ...EMBLEM_MOTIFS[plan.emblem], ...(plan.accent ? KEEPSAKE_MOTIFS[plan.accent] : [])]);
      for (const item of plan.motifs) {
        if (item.place !== 'corner' && item.place !== 'life') expect(kept.has(item.motif), `${plan.style} ${item.motif}`).toBe(false);
        expect(suits(item.motif, plan.style), `${plan.style} ${item.motif}`).toBe(true);
      }
      // One season: the eaves hold the island season's hanging, the trees stand as their kind does in its month, the small lives are about in it.
      const eaves = plan.motifs.find((item) => item.place === 'eaves')!;
      expect(keyOf(eavesOf(plan.season, plan.pillars.day.ganji.branch))).toBe(`${eaves.motif}:${eaves.variant ?? ''}`);
      for (const item of plan.motifs) {
        const tree = treeOfPlaced(item);
        expect(item.state).toBe(tree ? treeStateOf(tree, plan.season.branch) : undefined);
      }
      const life = plan.motifs.find((item) => item.place === 'life');
      if (plan.pillars.hour) {
        // The hour stem's own small lives, or sparrows when its magpies would join one already on the roof.
        const own = creatureOf(plan.pillars.hour.ganji.stem, plan.season.branch);
        expect(life!.motif === own || (own === 'magpie' && life!.motif === 'sparrows' && others.includes('magpie')), `${own} ${life!.motif}`).toBe(true);
      }
      // So many in each zone, and four things at most standing on the ground: the house stays the heart.
      const zones = (zone: Zone) => plan.motifs.filter((item) => item.zone === zone).length;
      expect([zones('land'), zones('garden'), zones('house'), zones('details')]).toEqual([1, 1, 2, plan.pillars.hour ? 3 : 0]);
      const standing = plan.motifs.filter((item) => GROUND.includes(item.place));
      expect(standing).toHaveLength(plan.pillars.hour ? 4 : 2);
      for (const item of standing) if (item.place === 'corner' || item.place === 'path') expect(MOTIFS[item.motif].long, item.motif).toBeUndefined();
      ground += standing.reduce((sum, item) => sum + (MOTIFS[item.motif].long ? 2 * MOTIFS[item.motif].reach : Math.PI * MOTIFS[item.motif].reach ** 2), 0);
      // The house's own dressings, one from each pillar.
      expect(plan.dress.stone.element).toBe(stemElement(plan.pillars.year.ganji.stem));
      expect(plan.dress.flowers.colors).toBe(plan.season.blooms);
      expect(plan.dress.door.main).toBe(plan.colors.day.main);
      expect(plan.dress.shoes?.kind ?? null).toBe(plan.pillars.hour ? SHOES[stemElement(plan.pillars.hour.ganji.stem) as Element].kind : null);
    }
    // The ground the pillars' things take, on average: well under a tenth of a neighbour's island.
    expect(ground / readings.length).toBeLessThan(16);
  });

  it('아직 그릴 수 없는 것만 그 자리의 다음 것으로 바꾸고, 그릴 수 있는 자리는 그대로 둔다', () => {
    const reading = readingOf(personOf('sol').birth);
    // 대림목: the great tree is the 甲 emblem's and its forest is taken, so something else of 목 stands for it.
    expect(islandPlanOf(reading, { taken: ['forestEdge'] }).pillars.year.motifs.map((item) => item.motif)).toEqual(['pines']);
    const ready = new Set(MOTIF_IDS.filter((motif) => MOTIFS[motif].build === 'ready'));
    for (const resident of PEOPLE) {
      const plan = islandPlanOf(readingOf(resident.birth), { drawable: ready });
      expect(plan.motifs.length).toBeGreaterThan(0);
      for (const item of plan.motifs) expect(MOTIFS[item.motif].build).toBe('ready');
    }
    // A place whose choice with the whole catalogue can be drawn keeps it, however few the builders can draw.
    const phase = new Set(MOTIF_IDS.filter((motif) => MOTIFS[motif].build !== 'new'));
    const slotOf = (item: IslandPlan['motifs'][number]) => `${item.pillar}:${item.place === 'roof' || item.place === 'front' ? 'house' : item.place === 'back' || item.place === 'shore' ? 'land' : item.place}`;
    for (const reading of manyReadings(400)) {
      const full = islandPlanOf(reading);
      const first = new Map(islandPlanOf(reading, { drawable: phase }).motifs.map((item) => [slotOf(item), item]));
      for (const item of full.motifs) {
        const before = first.get(slotOf(item));
        if (phase.has(item.motif)) expect(before && `${before.motif}:${before.variant ?? ''}:${before.place}`).toBe(`${item.motif}:${item.variant ?? ''}:${item.place}`);
      }
    }
  });

  it('시주의 나무는 납음이 과실나무면 그 나무, 아니면 시지의 나무이고, 섬의 달에 맞는 모습이다', () => {
    const base = readingOf(personOf('sol').birth);
    const corner = (hour: string, month?: string) => {
      const reading = { ...base, hour: standIn(base.hour!, GANJI.find((ganji) => ganji.cn === hour)!), ...(month ? { month: standIn(base.month, GANJI.find((ganji) => ganji.cn === month)!) } : {}) };
      return islandPlanOf(reading).motifs.find((item) => item.place === 'corner');
    };
    // 석류목 and 상자목 bring their own tree; the island (寅, early spring) has them bare.
    expect(corner('庚申')).toMatchObject({ motif: 'pomegranate', from: 'nayin', state: 'bare' });
    expect(corner('壬子')).toMatchObject({ motif: 'mulberry', from: 'nayin', state: 'bare' });
    // 戌's persimmons: in fruit in 戌, bare but for the magpies' share in 亥, bare in spring.
    expect(corner('甲戌', '甲戌')).toMatchObject({ motif: 'fruitTree', variant: 'persimmon', name: '감나무', from: 'branch', state: 'fruit' });
    expect(corner('甲戌', '乙亥')).toMatchObject({ variant: 'persimmon', state: 'lastFruit' });
    expect(corner('甲戌')).toMatchObject({ variant: 'persimmon', state: 'bare' });
    // 辰's cherry blossoms when the island is in 辰, and only then.
    expect(corner('丙辰', '丙辰')).toMatchObject({ variant: 'cherry', state: 'blossom' });
    expect(corner('丙辰', '甲子')).toMatchObject({ variant: 'cherry', state: 'bare' });
  });
});
