import { afterEach, describe, expect, it, vi } from 'vitest';

import { BRANCHES } from '../elements';
import { BirthError, chartOf, readingOf, type Birth } from '../engine';
import { SAHWA, ziweiOf, type Ziwei, type ZiweiPalace, type ZiweiStar } from '../ziwei';
import { PEOPLE, personOf } from './people';

const birth = (changes: Partial<Birth> = {}): Birth => ({ ...personOf('garam').birth, ...changes });
const drawn = (value: Birth): Ziwei => {
  const ziwei = ziweiOf(value);
  if (!ziwei) throw new Error('a birth with an hour has a 명반');
  return ziwei;
};
const of = (id: string) => drawn(personOf(id).birth);
const palace = (ziwei: Ziwei, name: string): ZiweiPalace => {
  const found = ziwei.palaces.find((item) => item.name === name);
  if (!found) throw new Error(`no such palace: ${name}`);
  return found;
};
/** `천량 묘 록`: a star with how bright it stands and its 사화, as a cell writes it. */
const written = (stars: readonly ZiweiStar[]) => stars.map((star) => [star.name, star.brightness, star.sahwa].filter(Boolean).join(' '));
const everyStar = (ziwei: Ziwei) => ziwei.palaces.flatMap(({ stars }) => [...stars.major, ...stars.lucky, ...stars.tough, ...stars.special, ...stars.misc]);

describe('명반 계산 (jamiblossom)', () => {
  it('같은 생일의 차트는 한 번만 계산하고, 사주는 그 차트에서 읽는다', () => {
    const chart = chartOf(birth());
    expect(chartOf(birth())).toBe(chart);
    expect(chartOf(birth({ gender: 'female' }))).not.toBe(chart);
    expect(chart.palaces).toHaveLength(12);
    expect(readingOf(birth()).day).toBe(chart.saju.day);
    expect(readingOf(birth()).daYun).toBe(chart.saju.daYun);
  });

  it('시계가 건너뛴 시각은 사주와 같이 까닭을 말한다', () => {
    const skipped = birth({ year: 1988, month: 5, day: 8, time: '02:30' });
    expect(() => chartOf(skipped)).toThrow(BirthError);
    expect(() => chartOf(skipped)).toThrow(/서머타임/);
    expect(() => ziweiOf(skipped)).toThrow(BirthError);
    expect(() => chartOf(birth({ year: 2023, month: 2, day: 30 }))).toThrow('계산할 수 없는 날짜예요.');
  });
});

describe('자미두수 명반', () => {
  it('태어난 시를 모르면 명반이 없다', () => {
    // 시가 없으면 라이브러리는 정오로 읽어 오시의 명반을 내는데, 그 사람의 것이 아니다.
    expect(ziweiOf(birth({ time: null }))).toBeNull();
    for (const person of PEOPLE) expect(ziweiOf({ ...person.birth, time: null })).toBeNull();
  });

  it('같은 생일의 명반은 한 번만 짓는다', () => {
    expect(ziweiOf(birth())).toBe(ziweiOf(birth()));
    expect(ziweiOf(birth({ time: '12:20' }))).not.toBe(ziweiOf(birth()));
  });

  it('열두 궁이 열두 지지에 하나씩, 4×4 고리의 테두리에 놓인다', () => {
    for (const person of PEOPLE) {
      const { palaces } = drawn(person.birth);
      expect(palaces).toHaveLength(12);
      expect(palaces.map((item) => item.name).sort()).toEqual(['관록', '노복', '명궁', '복덕', '부모', '부처', '자녀', '재백', '전택', '질액', '천이', '형제']);
      expect(new Set(palaces.map((item) => item.branch))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
      // 차트의 순서는 인(寅)에서 시작해 지지를 따라간다.
      expect(palaces.map((item) => item.branch)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1]);
      expect(palaces.map((item) => item.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      for (const item of palaces) {
        expect(item.ganji.hanja[1]).toBe(BRANCHES[item.branch]);
        expect(item.ganji.ko).toMatch(/^[갑을병정무기경신임계][자축인묘진사오미신유술해]$/);
        expect(item.ganji.hanja).toMatch(/^[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]$/);
        // 가운데 네 칸은 비운다.
        expect(item.row === 0 || item.row === 3 || item.col === 0 || item.col === 3).toBe(true);
      }
      expect(new Set(palaces.map((item) => `${item.row},${item.col}`)).size).toBe(12);
      // 사(巳)·신(申)·해(亥)·인(寅)이 네 귀퉁이다: 위 왼쪽부터 시계 방향으로.
      const cell = (branch: string) => palaces.filter((item) => item.ganji.hanja[1] === branch).map((item) => [item.row, item.col]);
      expect([cell('巳'), cell('申'), cell('亥'), cell('寅')]).toEqual([[[0, 0]], [[0, 3]], [[3, 3]], [[3, 0]]]);
      expect([cell('午'), cell('酉'), cell('子'), cell('卯')]).toEqual([[[0, 1]], [[1, 3]], [[3, 2]], [[2, 0]]]);
    }
  });

  it('명궁은 차트가 말하는 지지의 궁이고, 신궁과 래인궁도 하나씩이다', () => {
    for (const person of PEOPLE) {
      const chart = chartOf(person.birth);
      const ziwei = drawn(person.birth);
      const soul = ziwei.palaces[ziwei.soul]!;
      expect(soul.name).toBe('명궁');
      expect(soul.ganji.ko[1]).toBe(chart.earthlyBranchOfSoulPalace);
      expect(ziwei.palaces.filter((item) => item.isSoul)).toEqual([soul]);
      const body = ziwei.palaces.filter((item) => item.isBody);
      expect(body).toHaveLength(1);
      expect(body[0]).toBe(ziwei.palaces[ziwei.body!]);
      expect(body[0]!.ganji.ko[1]).toBe(chart.earthlyBranchOfBodyPalace);
      expect(ziwei.palaces.filter((item) => item.isOrigin)).toHaveLength(1);
    }
  });

  it('자미는 한 궁에만 있고, 주성 열넷이 모두 놓인다', () => {
    for (const person of PEOPLE) {
      const major = drawn(person.birth).palaces.flatMap((item) => item.stars.major);
      expect(major.filter((star) => star.name === '자미')).toHaveLength(1);
      expect(new Set(major.map((star) => star.name)).size).toBe(14);
      expect(major).toHaveLength(14);
      expect(major.every((star) => star.kind === 'major' && /^[묘왕득리평불함]$/.test(star.brightness))).toBe(true);
    }
  });

  it('차트의 별을 하나도 빠뜨리지 않고, 밝기는 일곱 글자 가운데 하나로 읽는다', () => {
    const brightness = new Set<string>();
    for (const person of PEOPLE) {
      const chart = chartOf(person.birth);
      const ziwei = drawn(person.birth);
      ziwei.palaces.forEach(({ stars }, index) => {
        const from = chart.palaces[index]!;
        expect(stars.major.map((star) => star.name)).toEqual(from.majorStars.map((star) => star.name));
        // 보좌·길성, 살성, 록존·천마로 나눈 것이 차트의 보성 전부다: 잡성으로 밀린 별이 없다.
        expect([...stars.lucky, ...stars.tough, ...stars.special].map((star) => star.name).sort()).toEqual(from.minorStars.map((star) => star.name).sort());
        expect(stars.misc.map((star) => star.name)).toEqual(from.adjectiveStars.map((star) => star.name));
      });
      for (const star of everyStar(ziwei)) brightness.add(star.brightness);
    }
    // 네 명반에 일곱 밝기가 다 나오고, 라이브러리의 부호([+3] … [-3])가 그대로 남은 별은 없다.
    expect(brightness).toEqual(new Set(['', '묘', '왕', '득', '리', '평', '불', '함']));
  });

  it('삼방사정: 삼합은 고리를 네 칸씩 건너고, 대궁은 맞은편이다', () => {
    for (const person of PEOPLE) {
      const { palaces } = drawn(person.birth);
      for (const item of palaces) {
        const { trines, opposite } = item.surround!;
        expect(trines.map((index) => palaces[index]!.branch)).toEqual([(item.branch + 4) % 12, (item.branch + 8) % 12]);
        const across = palaces[opposite]!;
        expect(across.branch).toBe((item.branch + 6) % 12);
        // 고리 위에서 맞은편은 가운데를 지나 마주 보는 칸이다.
        expect([across.row, across.col]).toEqual([3 - item.row, 3 - item.col]);
      }
    }
  });

  it('별을 종류대로 나누고 밝기와 사화를 읽는다', () => {
    const ziwei = of('garam');
    const servants = palace(ziwei, '노복');
    expect(written(servants.stars.major)).toEqual(['천동 리', '천량 묘 록']);
    expect(written(servants.stars.special)).toEqual(['천마']);
    expect(written(servants.stars.misc)).toEqual(['봉각', '절로', '천허', '천상', '해신(년)']);
    expect(servants.stars.misc.every((star) => star.kind === 'misc' && star.brightness === '' && star.sahwa === null)).toBe(true);
    const career = palace(ziwei, '관록');
    expect(written(career.stars.lucky)).toEqual(['좌보 과', '우필']);
    expect(written(career.stars.tough)).toEqual(['지겁']);
    expect(written(palace(ziwei, '전택').stars.tough)).toEqual(['령성 함', '경양 함']);
    expect(written(palace(ziwei, '복덕').stars.special)).toEqual(['록존']);
    // 임(壬)년생의 생년사화: 천량 록, 자미 권, 좌보 과, 무곡 기.
    const turned = everyStar(ziwei).filter((star) => star.sahwa);
    expect(Object.fromEntries(turned.map((star) => [star.sahwa, star.name]))).toEqual({ 록: '천량', 권: '자미', 과: '좌보', 기: '무곡' });
    expect(turned).toHaveLength(4);
    // 읽기가 같은 별은 한자가 가른다: 보좌성 천월(天鉞)과 잡성 천월(天月).
    expect(everyStar(ziwei).filter((star) => star.name === '천월').map((star) => `${star.kind} ${star.hanja}`)).toEqual(['lucky 天鉞', 'misc 天月']);
    expect(new Set(everyStar(ziwei).map((star) => star.id)).size).toBe(everyStar(ziwei).length);
  });

  it('마을이 기대하는 명반: 가람', () => {
    const ziwei = of('garam');
    expect(ziwei.bureau).toEqual({ name: '토오국', element: 'earth' });
    expect([ziwei.soulStar, ziwei.bodyStar]).toEqual(['문곡', '천량']);
    expect(ziwei.lunarDate).toBe('1992년 10월 18일');
    expect(ziwei.hour).toEqual({ name: '인시', range: '03:30~05:29' });
    expect(ziwei.palaces.map((item) => `${item.name} ${item.ganji.ko}`)).toEqual([
      '노복 임인', '천이 계묘', '질액 갑진', '재백 을사', '자녀 병오', '부처 정미', '형제 무신', '명궁 기유', '부모 경술', '복덕 신해', '전택 임자', '관록 계축',
    ]);
    const soul = ziwei.palaces[ziwei.soul]!;
    expect(soul.ganji).toEqual({ ko: '기유', hanja: '己酉' });
    expect([soul.row, soul.col]).toEqual([1, 3]);
    expect(written(soul.stars.major)).toEqual(['천부 왕']);
    expect(written(soul.stars.tough)).toEqual(['지공']);
    expect(soul.cycles).toEqual([
      { label: '장생', name: '목욕' },
      { label: '박사', name: '복병' },
      { label: '장전', name: '함지' },
      { label: '태세', name: '회기' },
    ]);
    expect(soul.decade).toEqual({ from: 5, to: 14 });
    expect(soul.ages).toEqual([12, 24, 36, 48, 60, 72, 84, 96, 108, 120]);
    expect(soul.surround!.trines.map((index) => ziwei.palaces[index]!.name)).toEqual(['관록', '재백']);
    expect(ziwei.palaces[soul.surround!.opposite]!.name).toBe('천이');
    expect(soul.flies.map((fly) => `${fly.sahwa} ${ziwei.palaces[fly.to]!.name}`)).toEqual(['록 천이', '권 복덕', '과 노복', '기 자녀']);
    expect(ziwei.palaces[ziwei.body!]!.name).toBe('관록');
    expect(palace(ziwei, '노복').isOrigin).toBe(true);
    const spouse = palace(ziwei, '부처');
    expect(written(spouse.stars.major)).toEqual(['자미 묘 권', '파군 왕']);
    expect(spouse.stars.major[0]!.hanja).toBe('紫微');
    // 주성이 없는 궁도 있다.
    expect(palace(ziwei, '재백').stars.major).toEqual([]);
    expect(palace(ziwei, '형제').stars.major).toEqual([]);
  });

  it('마을이 기대하는 명반: 솔, 노을, 보리', () => {
    const sol = of('sol');
    expect([sol.bureau.name, sol.bureau.element, sol.soulStar, sol.bodyStar, sol.lunarDate]).toEqual(['화육국', 'fire', '문곡', '천기', '1989년 1월 18일']);
    expect(sol.hour).toEqual({ name: '해시', range: '21:30~23:29' });
    expect(sol.palaces[sol.soul]!.ganji.ko).toBe('정묘');
    expect(written(sol.palaces[sol.soul]!.stars.major)).toEqual(['천기 왕', '거문 묘']);
    expect(written(sol.palaces[sol.soul]!.stars.lucky)).toEqual(['문곡 왕 기']);
    expect(palace(sol, '부모').stars.major.map((star) => star.name)).toEqual(['자미', '천상']);

    const noeul = of('noeul');
    expect([noeul.bureau.name, noeul.bureau.element, noeul.soulStar, noeul.bodyStar, noeul.lunarDate]).toEqual(['금사국', 'metal', '록존', '천동', '1987년 5월 21일']);
    expect(noeul.palaces[noeul.soul]!.ganji.ko).toBe('임인');
    expect(written(noeul.palaces[noeul.soul]!.stars.major)).toEqual(['탐랑 평']);
    expect(noeul.palaces[noeul.body!]!.name).toBe('재백');
    // 네 명반 가운데 한 궁에 잡성이 가장 많은 궁이다.
    expect(palace(noeul, '전택').stars.misc.map((star) => star.name)).toEqual(['천요', '천재', '천무', '천주', '고진', '비렴', '파쇄']);
    expect(written(palace(noeul, '관록').stars.lucky)).toEqual(['우필', '문창 함']);
    expect(written(palace(noeul, '부모').stars.major)).toEqual(['천기 왕 과', '거문 묘 기']);

    // 음력으로 넣은 생일이고, 서머타임이던 날이라 06:15가 인시다.
    const bori = of('bori');
    expect([bori.bureau.name, bori.bureau.element, bori.soulStar, bori.bodyStar, bori.lunarDate]).toEqual(['화육국', 'fire', '무곡', '문창', '1988년 8월 21일']);
    expect(bori.hour).toEqual({ name: '인시', range: '04:30~06:29' });
    expect(bori.palaces[bori.soul]!.ganji).toEqual({ ko: '기미', hanja: '己未' });
    expect(written(bori.palaces[bori.soul]!.stars.major)).toEqual(['천량 왕']);
    expect(written(palace(bori, '질액').stars.major)).toEqual(['자미 왕', '천부 묘']);
    expect(written(palace(bori, '재백').stars.lucky)).toEqual(['우필 과']);
  });

  it('음력 날짜는 윤달을, 시진은 조자시와 야자시를 가려 적는다', () => {
    expect(drawn(birth({ calendar: 'lunar', year: 2020, month: 4, day: 10, leapMonth: true })).lunarDate).toBe('2020년 윤4월 10일');
    expect(drawn(birth({ calendar: 'lunar', year: 2020, month: 4, day: 10 })).lunarDate).toBe('2020년 4월 10일');
    expect(drawn(birth({ time: '23:50' })).hour).toEqual({ name: '자시(야자)', range: '23:30~00:29' });
    expect(drawn(birth({ time: '00:40' })).hour).toEqual({ name: '자시(조자)', range: '00:30~01:29' });
  });

  it('대한은 명궁에서 시작해 열두 궁이 십 년씩 잇고, 지금의 대한은 많아야 하나다', () => {
    for (const person of PEOPLE) {
      const ziwei = drawn(person.birth);
      const decades = ziwei.palaces.map((item) => item.decade!).sort((a, b) => a.from - b.from);
      expect(decades[0]).toEqual(ziwei.palaces[ziwei.soul]!.decade);
      decades.forEach((decade, step) => {
        expect(decade.to).toBe(decade.from + 9);
        if (step > 0) expect(decade.from).toBe(decades[step - 1]!.to + 1);
      });
      // 소한은 열두 해에 한 번씩 돌아온다.
      for (const item of ziwei.palaces) expect(item.ages.slice(1).every((age, step) => age === item.ages[step]! + 12)).toBe(true);
      expect(new Set(ziwei.palaces.map((item) => item.ages[0])).size).toBe(12);
      expect(ziwei.palaces.filter((item) => item.isCurrent).length).toBeLessThanOrEqual(1);
    }
  });

  describe('지금의 대한', () => {
    afterEach(() => {
      vi.useRealTimers();
    });
    const on = (day: string) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(`${day}T12:00:00+09:00`));
    };
    const current = (ziwei: Ziwei) => ziwei.palaces.filter((item) => item.isCurrent).map((item) => `${item.name} ${item.decade?.from}–${item.decade?.to}`);

    // 차트는 처음 계산한 날의 대한을 담으므로, 날마다 아직 계산하지 않은 시각(같은 인시)으로 읽는다.
    it('그 나이가 든 대한의 궁 하나를 표시한다', () => {
      // 1992년생은 2026년에 서른다섯이다.
      on('2026-11-14');
      expect(current(drawn(birth({ time: '04:21' })))).toEqual(['전택 35–44']);
      // 나이는 음력 설에 한 살을 더한다: 2036년의 설(1월 28일) 전날까지 마흔넷이다.
      on('2036-01-27');
      expect(current(drawn(birth({ time: '04:22' })))).toEqual(['전택 35–44']);
      on('2036-01-28');
      expect(current(drawn(birth({ time: '04:23' })))).toEqual(['관록 45–54']);
    });

    it('첫 대한이 시작되기 전에는 어느 궁도 아니다', () => {
      // 토오국은 다섯 살에 첫 대한이 든다.
      on('1995-06-01');
      expect(current(drawn(birth({ time: '04:24' })))).toEqual([]);
      on('1996-06-01');
      expect(current(drawn(birth({ time: '04:25' })))).toEqual(['명궁 5–14']);
    });
  });

  it('비성사화는 궁마다 록·권·과·기 넷이고, 명반에 있는 궁으로 간다', () => {
    for (const person of PEOPLE) {
      const { palaces } = drawn(person.birth);
      for (const item of palaces) {
        expect(item.flies.map((fly) => fly.sahwa)).toEqual([...SAHWA]);
        expect(item.flies.every((fly) => palaces[fly.to] !== undefined)).toBe(true);
      }
    }
    // 같은 천간의 궁은 같은 곳으로 보낸다: 가람의 노복과 전택은 둘 다 임(壬)이다.
    const garam = of('garam');
    expect(palace(garam, '노복').flies).toEqual(palace(garam, '전택').flies);
    // 제 궁의 별을 바꾸면 제 궁으로 돌아온다(자화).
    expect(palace(garam, '노복').flies[0]).toEqual({ sahwa: '록', to: palace(garam, '노복').index });
  });
});
