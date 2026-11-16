import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readingChartOf } from '../readingChart';
import { personOf } from './people';

describe('풀이를 쓸 차트', () => {
  // 지금의 대운과 대한은 오늘 날짜로 정해진다: 그날을 정해 두고 본다.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T12:00:00+09:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('네 기둥을 년주부터 한자 간지와 한글 십성·지장간·12운성·납음으로 적고, 일간은 일간이라 부른다', () => {
    const { saju } = readingChartOf(personOf('noeul').birth);
    expect(saju.pillars).toEqual([
      { key: 'year', stem: '丁', branch: '卯', tenGodStem: '비견', tenGodBranch: '편인', hidden: '을', stage: '병', nayin: '노중화' },
      { key: 'month', stem: '丙', branch: '午', tenGodStem: '겁재', tenGodBranch: '비견', hidden: '정기', stage: '건록', nayin: '천하수' },
      { key: 'day', stem: '丁', branch: '酉', tenGodStem: '일간', tenGodBranch: '편재', hidden: '신', stage: '장생', nayin: '산하화' },
      { key: 'hour', stem: '甲', branch: '辰', tenGodStem: '정인', tenGodBranch: '상관', hidden: '무을계', stage: '쇠', nayin: '복등화' },
    ]);
    expect(saju.dayMaster).toBe('丁');
    // 여덟 글자의 오행: 사주보기의 오행 밸런스와 같다.
    expect(saju.elements).toEqual({ wood: 2, fire: 4, earth: 1, metal: 1, water: 0 });
  });

  it('해당하는 신살과 다른 기둥에 든 12신살을 한 번씩 적는다', () => {
    const { sinsal } = readingChartOf(personOf('noeul').birth).saju;
    expect(sinsal).toEqual([
      '천을귀인', '문창귀인', '문곡귀인', '태극귀인', '건록', '천주귀인', '학당귀인', '월덕귀인', '백호대살', '현침살', '공망',
      // 년지 기준으로 월·일·시지, 일지 기준으로 년·월·시지에 든 것. 장성살은 년지와 일지 제 자리에만 있어 들지 않는다.
      '재살', '육해살', '년살(도화)', '반안살', '천살',
    ]);
  });

  it('대운은 간지가 있는 것만 차례로, 나이와 지금 도는 것을 함께 적는다', () => {
    const { daeun } = readingChartOf(personOf('noeul').birth).saju;
    expect(daeun.length).toBeGreaterThan(8);
    expect(daeun[0]).toMatchObject({ ganzhi: '을사' });
    expect(daeun.every(({ ganzhi, from, to }) => /^[가-힣]{2}$/.test(ganzhi) && to > from)).toBe(true);
    expect(daeun.filter(({ current }) => current)).toHaveLength(1);
    // 서른아홉의 노을은 그 나이가 든 대운 안에 있다.
    const now = daeun.find(({ current }) => current)!;
    expect(now.from <= 40 && 40 <= now.to).toBe(true);
  });

  it('명반은 명궁부터 열두 궁을, 별마다 종류와 밝기·사화를 적는다', () => {
    const { ziwei } = readingChartOf(personOf('garam').birth);
    expect(ziwei).not.toBeNull();
    expect([ziwei!.bureau, ziwei!.soulStar, ziwei!.bodyStar]).toEqual(['토오국', '문곡', '천량']);
    const palaces = ziwei!.palaces;
    expect(palaces.map((palace) => `${palace.name} ${palace.ganzhi}`)).toEqual([
      '명궁 기유', '부모 경술', '복덕 신해', '전택 임자', '관록 계축', '노복 임인',
      '천이 계묘', '질액 갑진', '재백 을사', '자녀 병오', '부처 정미', '형제 무신',
    ]);
    expect(palaces.filter((palace) => palace.soul).map((palace) => palace.name)).toEqual(['명궁']);
    expect(palaces.filter((palace) => palace.body).map((palace) => palace.name)).toEqual(['관록']);
    expect(palaces.filter((palace) => palace.current).map((palace) => [palace.name, palace.decade])).toEqual([['전택', [35, 44]]]);
    const spouse = palaces.find((palace) => palace.name === '부처')!;
    expect(spouse.decade).toEqual([105, 114]);
    expect(spouse.stars.filter((star) => star.kind === 'major')).toEqual([
      { name: '자미', kind: 'major', brightness: '묘', sahwa: '권' },
      { name: '파군', kind: 'major', brightness: '왕', sahwa: null },
    ]);
    expect(spouse.stars.filter((star) => star.kind === 'minor').map((star) => star.name)).toEqual(expect.arrayContaining(['홍란', '과숙']));
    const career = palaces.find((palace) => palace.name === '관록')!;
    expect(career.stars.filter((star) => star.kind === 'helper' || star.kind === 'tough').map((star) => `${star.kind} ${star.name}${star.sahwa ?? ''}`)).toEqual([
      'helper 좌보과',
      'helper 우필',
      'tough 지겁',
    ]);
    // 주성 다음에 보좌·살성·록존과 천마·잡성 순이고, 밝기는 일곱 가지 가운데 하나이거나 없다.
    const order = ['major', 'helper', 'tough', 'special', 'minor'];
    for (const palace of palaces) {
      const kinds = palace.stars.map((star) => order.indexOf(star.kind));
      expect(kinds).toEqual([...kinds].sort((a, b) => a - b));
      expect(palace.stars.every((star) => ['', '묘', '왕', '득', '리', '평', '불', '함'].includes(star.brightness))).toBe(true);
    }
  });

  it('생일은 저장된 그대로 보내고, 시를 모르면 세 기둥에 명반 없이 적는다', () => {
    const birth = { ...personOf('noeul').birth, time: null };
    const chart = readingChartOf(birth);
    expect(chart.birth).toEqual(birth);
    expect(chart.saju.pillars.map((pillar) => pillar.key)).toEqual(['year', 'month', 'day']);
    expect(Object.values(chart.saju.elements).reduce((sum, count) => sum + count, 0)).toBe(6);
    expect(chart.ziwei).toBeNull();
    // 음력 생일도 그대로 간다.
    const bori = personOf('bori').birth;
    expect(readingChartOf(bori).birth).toEqual(bori);
  });
});
