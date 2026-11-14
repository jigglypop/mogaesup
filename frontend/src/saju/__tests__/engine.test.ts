import { describe, expect, it } from 'vitest';

import { branchElement, elementOfHanja, stemElement } from '../elements';
import { BirthError, hasLeapMonth, isValidBirthDate, pillarsOf, readingOf, solarDateOf, timeBranchOf, timeBranches, type Birth } from '../engine';

const birth = (changes: Partial<Birth> = {}): Birth => ({
  calendar: 'solar',
  year: 1990,
  month: 1,
  day: 1,
  leapMonth: false,
  time: '12:00',
  gender: 'male',
  ...changes,
});
const pillars = (value: Birth) => pillarsOf(readingOf(value)).map(({ pillar }) => pillar.cn).join(' ');

describe('사주 계산 (jamiblossom)', () => {
  it('양력 생년월일시로 네 기둥을 세운다', () => {
    // 1990년 1월 1일은 입춘 전이라 년주가 己巳이고, 정오는 오시다.
    expect(pillars(birth())).toBe('己巳 丙子 丙寅 甲午');
    const reading = readingOf(birth());
    expect(reading.day.shiShenGan).toBe('일원');
    expect(reading.month.hideGanKo).toBe('계');
    expect(reading.solarDate).toBe('1990-1-1');
    expect(reading.daYun.length).toBeGreaterThan(8);
  });

  it('음력으로 넣어도 같은 날의 사주다', () => {
    const lunar = birth({ calendar: 'lunar', year: 1988, month: 8, day: 21, time: '06:15', gender: 'female' });
    const solar = birth({ year: 1988, month: 10, day: 1, time: '06:15', gender: 'female' });
    expect(solarDateOf(lunar)).toBe('1988-10-1');
    expect(pillars(lunar)).toBe(pillars(solar));
  });

  it('서머타임이던 날은 시계가 한 시간 앞서 있었다', () => {
    // 1988-10-01은 서머타임 기간이라 06:15가 인시다. 서머타임이 없던 해의 06:15는 묘시다.
    expect(timeBranchOf('1988-10-1', '06:15')).toBe(2);
    expect(timeBranchOf('1995-3-24', '06:15')).toBe(3);
    expect(timeBranches('1988-10-1').find((option) => option.index === 2)?.range).toBe('04:30~06:29');
    expect(pillars(birth({ year: 1988, month: 10, day: 1, time: '06:15' }))).toBe('戊辰 辛酉 己丑 丙寅');
  });

  it('시계가 건너뛴 시각은 계산하지 않고 까닭을 말한다', () => {
    // 1988년 5월 8일 02:00에 시계를 03:00으로 돌렸다.
    const skipped = birth({ year: 1988, month: 5, day: 8, time: '02:30' });
    expect(timeBranchOf('1988-5-8', '02:30')).toBeNull();
    expect(() => readingOf(skipped)).toThrow(BirthError);
    expect(() => readingOf(skipped)).toThrow(/서머타임/);
  });

  it('태어난 시를 모르면 시주 없이 세 기둥으로 읽는다', () => {
    const reading = readingOf(birth({ time: null }));
    expect(reading.hour).toBeNull();
    expect(pillarsOf(reading).map(({ key }) => key)).toEqual(['year', 'month', 'day']);
    expect(pillars(birth({ time: null }))).toBe('己巳 丙子 丙寅');
    expect(reading.sinsal.twelve.map((cell) => cell.pillar)).toEqual(['year', 'month', 'day']);
    expect(reading.sinsal.checks.flatMap((check) => check.matchedPillars)).not.toContain('hour');
    // 시주(甲午)가 있어야 맞는 양인살은 세 기둥에서는 해당하지 않는다.
    expect(readingOf(birth()).sinsal.checks.find((check) => check.id === 'yang-blade')?.matched).toBe(true);
    expect(reading.sinsal.checks.find((check) => check.id === 'yang-blade')?.matched).toBe(false);
  });

  it('같은 생일은 한 번만 계산한다', () => {
    expect(readingOf(birth())).toBe(readingOf(birth()));
    expect(readingOf(birth({ gender: 'female' }))).not.toBe(readingOf(birth()));
  });

  it('기둥의 오행은 천간·지지의 오행과 같다', () => {
    for (const { pillar } of pillarsOf(readingOf(birth()))) {
      expect(elementOfHanja(pillar.wuxing[0]!)).toBe(stemElement(pillar.stem));
      expect(elementOfHanja(pillar.wuxing[1]!)).toBe(branchElement(pillar.branch));
    }
  });
});

describe('생일 확인', () => {
  it('달력에 없는 날과 아직 오지 않은 날은 받지 않는다', () => {
    expect(isValidBirthDate(birth())).toBe(true);
    expect(isValidBirthDate(birth({ year: 2023, month: 2, day: 30 }))).toBe(false);
    expect(isValidBirthDate(birth({ year: 2050, month: 1, day: 1 }))).toBe(false);
    expect(isValidBirthDate(birth({ year: 1990.5 }))).toBe(false);
    expect(() => readingOf(birth({ year: 2023, month: 2, day: 30 }))).toThrow(BirthError);
  });

  it('윤달은 그 해에 있는 달만 받는다', () => {
    expect(hasLeapMonth(2020, 4)).toBe(true);
    expect(hasLeapMonth(2021, 4)).toBe(false);
    expect(isValidBirthDate(birth({ calendar: 'lunar', year: 2020, month: 4, day: 10, leapMonth: true }))).toBe(true);
    expect(isValidBirthDate(birth({ calendar: 'lunar', year: 2021, month: 4, day: 10, leapMonth: true }))).toBe(false);
    expect(solarDateOf(birth({ calendar: 'lunar', year: 2021, month: 4, day: 10, leapMonth: true }))).toBeNull();
  });
});
