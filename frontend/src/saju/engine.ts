import {
  calculateSinsal,
  calculateZiweiChart,
  isValidKoreanDate,
  koreanLunarMonthDays,
  koreanLunarToSolar,
  seoulNowParts,
  timeBranchOptionsAtSeoulDate,
  timeToIndexAtSeoulDate,
  type Chart,
  type ChartRequest,
  type DaYunItem,
  type SajuPillar,
  type SinsalResult,
  type TimeBranchOption,
} from 'jamiblossom';

// 사주 comes from jamiblossom (vendor/jamiblossom-*.tgz), unchanged: the pillars, 십성, 지장간, 12운성, 대운 and 신살 are
// its results, read by Seoul's civil clock (historic offsets and summer time included). This file only shapes a birth
// into its request and leaves out what a birth without an hour cannot know. The 자미두수 명반 the same calculation draws
// goes out whole (`chartOf`); `ziwei.ts` shapes it.

export type Calendar = 'solar' | 'lunar';
export type Gender = 'female' | 'male';

/** When someone was born, by Seoul's clock. */
export type Birth = {
  calendar: Calendar;
  year: number;
  month: number;
  day: number;
  /** A lunar date in that year's leap month. */
  leapMonth: boolean;
  /** `HH:MM`, or null when the hour is not known. */
  time: string | null;
  gender: Gender;
};

export type Pillar = SajuPillar;
export type PillarKey = 'year' | 'month' | 'day' | 'hour';

/** One birth's 사주, as jamiblossom calculates it. */
export type Reading = {
  year: Pillar;
  month: Pillar;
  day: Pillar;
  /** Null when the birth hour is not known. */
  hour: Pillar | null;
  sinsal: SinsalResult;
  /** 대운 in order; the first is the years before the first 대운 begins. */
  daYun: DaYunItem[];
  currentDaYun: number | null;
  /** 순행, or 역행. */
  forward: boolean;
  /** How long after birth the first 대운 begins (`8년 4개월 0일`). */
  daYunStart: string;
  /** The birth date in the solar calendar, `YYYY-M-D`. */
  solarDate: string;
};

export class BirthError extends Error {}

const dateOf = (birth: Pick<Birth, 'year' | 'month' | 'day'>) => `${birth.year}-${birth.month}-${birth.day}`;

/** Whether the date exists in its calendar, within the years jamiblossom's Korean calendar covers, and is not ahead of today. */
export function isValidBirthDate(birth: Pick<Birth, 'calendar' | 'year' | 'month' | 'day' | 'leapMonth'>): boolean {
  const leap = birth.calendar === 'lunar' && birth.leapMonth;
  if (![birth.year, birth.month, birth.day].every(Number.isInteger)) return false;
  if (!isValidKoreanDate(birth.calendar, dateOf(birth), leap)) return false;
  const solar = birth.calendar === 'lunar' ? koreanLunarToSolar(dateOf(birth), leap) : dateOf(birth);
  const [year = 0, month = 0, day = 0] = solar.split('-').map(Number);
  const [todayYear = 0, todayMonth = 0, todayDay = 0] = seoulNowParts().date.split('-').map(Number);
  return year * 10_000 + month * 100 + day <= todayYear * 10_000 + todayMonth * 100 + todayDay;
}

/** Whether lunar `year` has a leap month after `month`. */
export function hasLeapMonth(year: number, month: number): boolean {
  try {
    return koreanLunarMonthDays(year, month, true) > 0;
  } catch {
    return false;
  }
}

/** The solar date of a birth date in either calendar, or null when the date does not exist. */
export function solarDateOf(birth: Pick<Birth, 'calendar' | 'year' | 'month' | 'day' | 'leapMonth'>): string | null {
  const leap = birth.calendar === 'lunar' && birth.leapMonth;
  if (!isValidKoreanDate(birth.calendar, dateOf(birth), leap)) return null;
  return birth.calendar === 'lunar' ? koreanLunarToSolar(dateOf(birth), leap) : dateOf(birth);
}

/** The 시진 a clock time falls in on a solar date (0 조자시 … 12 야자시), or null for a time that date's clock skipped or ran twice. */
export function timeBranchOf(solarDate: string, time: string): number | null {
  try {
    return timeToIndexAtSeoulDate(solarDate, time);
  } catch {
    return null;
  }
}

/** The 시진 of a solar date with the civil-clock range of each: summer time and old offsets move them. */
export function timeBranches(solarDate: string): TimeBranchOption[] {
  return timeBranchOptionsAtSeoulDate(solarDate);
}

/** Stands in for an unknown hour pillar: no table of jamiblossom's 신살 holds this character. */
const UNKNOWN = '？';

/** What tells one birth from another: the same for two that read alike. */
export const keyOf = (birth: Birth) => JSON.stringify([birth.calendar, birth.year, birth.month, birth.day, birth.leapMonth, birth.time, birth.gender]);
const charts = new Map<string, Chart>();
const readings = new Map<string, Reading>();
/** The Seoul day the charts kept here were drawn on. A chart also says what is running that day (the 대운, the 명반's 대한). */
let drawnOn = '';

/** Lets go of the charts of an earlier day: a page left open draws them again, with what is running today. */
function forgetOlder(): void {
  const today = seoulNowParts().date;
  if (today === drawnOn) return;
  drawnOn = today;
  charts.clear();
  readings.clear();
}

/**
 * All jamiblossom calculates of a birth in one go: its 사주, and the 자미두수 명반 it draws on the way. Without a birth
 * hour it reads the day at noon, so the hour pillar and the whole 명반 (午時's) of that chart are not the person's.
 * @throws {BirthError} for a date or time that does not exist (the message is for the person who typed it).
 */
export function chartOf(birth: Birth): Chart {
  forgetOlder();
  const key = keyOf(birth);
  const known = charts.get(key);
  if (known) return known;
  const request: ChartRequest = {
    calendar: birth.calendar,
    date: dateOf(birth),
    gender: birth.gender,
    isLeapMonth: birth.calendar === 'lunar' && birth.leapMonth,
    language: 'ko-KR',
    ...(birth.time ? { time: birth.time } : {}),
  };
  let chart;
  try {
    chart = calculateZiweiChart(request);
  } catch (problem) {
    const message = problem instanceof Error ? problem.message : '';
    // jamiblossom explains a skipped or repeated summer-time hour in Korean; its other refusals are a date out of range.
    throw new BirthError(/[가-힣]/.test(message) ? message : '계산할 수 없는 날짜예요.');
  }
  charts.set(key, chart);
  return chart;
}

/**
 * The 사주 of a birth. Without a birth hour jamiblossom reads the day at noon; the hour pillar is then left out, and the
 * 신살 are judged again from the three pillars alone.
 * @throws {BirthError} for a date or time that does not exist (the message is for the person who typed it).
 */
export function readingOf(birth: Birth): Reading {
  forgetOlder();
  const key = keyOf(birth);
  const known = readings.get(key);
  if (known) return known;
  const chart = chartOf(birth);
  const { saju } = chart;
  const reading: Reading = {
    year: saju.year,
    month: saju.month,
    day: saju.day,
    hour: birth.time ? saju.hour : null,
    sinsal: birth.time
      ? saju.sinsal
      : calculateSinsal({ year: saju.year, month: saju.month, day: saju.day, hour: { stem: UNKNOWN, branch: UNKNOWN, cn: UNKNOWN + UNKNOWN } }),
    daYun: saju.daYun,
    currentDaYun: saju.currentDaYunIndex,
    forward: saju.isForward,
    daYunStart: saju.yunStartDesc,
    solarDate: chart.inputSolarDate ?? chart.solarDate,
  };
  if (!birth.time) {
    reading.sinsal = { ...reading.sinsal, twelve: reading.sinsal.twelve.filter((cell) => cell.pillar !== 'hour') };
  }
  readings.set(key, reading);
  return reading;
}

/** The pillars a reading has, 년주 first. */
export function pillarsOf(reading: Reading): { key: PillarKey; pillar: Pillar }[] {
  const pillars: { key: PillarKey; pillar: Pillar }[] = [
    { key: 'year', pillar: reading.year },
    { key: 'month', pillar: reading.month },
    { key: 'day', pillar: reading.day },
  ];
  if (reading.hour) pillars.push({ key: 'hour', pillar: reading.hour });
  return pillars;
}
