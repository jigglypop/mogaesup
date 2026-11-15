import type { ReadingChart } from '../api/types';
import { pillarsOf, type Birth, type Reading } from './engine';
import { nayinKo, stageKo } from './labels';
import { profileOf } from './profile';
import { STAR_KINDS, ziweiOf, type StarKind, type Ziwei } from './ziwei';

// What a home's reading is written from. jamiblossom runs in the browser only, so the chart the page draws is sent to
// the server as it stands, in the chart's own words: nothing here is calculated again, only named as the reading's
// chart names it.

type Star = NonNullable<ReadingChart['ziwei']>['palaces'][number]['stars'][number];

/** The reading's names for a 명반's kinds of star. */
const STAR_KIND: Record<StarKind, Star['kind']> = { major: 'major', lucky: 'helper', tough: 'tough', special: 'special', misc: 'minor' };
/** How bright a star can stand, 묘 the brightest. */
const BRIGHTNESS = new Set(['묘', '왕', '득', '리', '평', '불', '함']);
/** jamiblossom calls the day stem's own 십성 일원; the reading's chart calls it 일간. */
const DAY_STEM = '일간';

/**
 * The 신살 a chart holds, by name: the ones it matches, then the 12신살 another pillar carries (counted from the year
 * branch or the day branch, as the guardian's charms are), each once.
 */
function sinsalOf(reading: Reading): string[] {
  const matched = reading.sinsal.checks.filter((check) => check.matched).map((check) => check.name);
  const twelve = reading.sinsal.twelve.flatMap((cell) => [
    ...(cell.pillar !== 'year' && cell.yearBasis ? [cell.yearBasis] : []),
    ...(cell.pillar !== 'day' && cell.dayBasis ? [cell.dayBasis] : []),
  ]);
  return [...new Set([...matched, ...twelve])];
}

function ziweiPartOf(ziwei: Ziwei): NonNullable<ReadingChart['ziwei']> {
  // Round the ring from the 명궁, the way a 명반 is read.
  const inTurn = [...ziwei.palaces.slice(ziwei.soul), ...ziwei.palaces.slice(0, ziwei.soul)];
  return {
    bureau: ziwei.bureau.name,
    soulStar: ziwei.soulStar,
    bodyStar: ziwei.bodyStar,
    palaces: inTurn.map((palace) => ({
      name: palace.name,
      ganzhi: palace.ganji.ko,
      stars: STAR_KINDS.flatMap(({ kind }) =>
        palace.stars[kind].map((star) => ({
          name: star.name,
          kind: STAR_KIND[kind],
          brightness: BRIGHTNESS.has(star.brightness) ? star.brightness : '',
          sahwa: star.sahwa,
        })),
      ),
      decade: palace.decade ? [palace.decade.from, palace.decade.to] : null,
      soul: palace.isSoul,
      body: palace.isBody,
      current: palace.isCurrent,
    })),
  };
}

/**
 * The chart a reading of `birth` is written from: its 사주 as the 사주보기 tab shows it and its 명반 as the 자미두수 tab
 * draws it (none for a birth without an hour). `birth` goes with it unchanged: the server writes the reading only for
 * the birth it keeps for the home.
 * @throws {BirthError} for a birth jamiblossom cannot read, as {@link profileOf} does.
 */
export function readingChartOf(birth: Birth): ReadingChart {
  const { reading, balance, dayMaster } = profileOf(birth);
  const ziwei = ziweiOf(birth);
  const { calendar, year, month, day, leapMonth, time, gender } = birth;
  return {
    birth: { calendar, year, month, day, leapMonth, time, gender },
    saju: {
      pillars: pillarsOf(reading).map(({ key, pillar }) => ({
        key,
        stem: pillar.stem,
        branch: pillar.branch,
        tenGodStem: key === 'day' ? DAY_STEM : pillar.shiShenGan,
        tenGodBranch: pillar.shiShenBranch,
        hidden: pillar.hideGanKo,
        stage: stageKo(pillar.diShi),
        nayin: nayinKo(pillar.nayin),
      })),
      elements: { ...balance.counts },
      dayMaster: dayMaster.stem,
      sinsal: sinsalOf(reading),
      // The first of jamiblossom's 대운 is the years before the first one begins, with no 간지 of its own.
      daeun: reading.daYun.flatMap((item, index) =>
        item.ganZhi ? [{ ganzhi: item.ganZhiKo, from: item.startAge, to: item.endAge, current: index === reading.currentDaYun }] : [],
      ),
    },
    ziwei: ziwei && ziweiPartOf(ziwei),
  };
}
