import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { readingOf } from '../engine';
import { nayinKo, stageKo } from '../labels';

const HANGUL = /^[가-힣]+$/;

describe('한글 표기', () => {
  it('육십갑자의 납음 서른 가지를 모두 한글로 읽는다', () => {
    // 납음의 이름은 jamiblossom이 쓰는 lunar-javascript의 표에서 온다.
    const { LunarUtil } = createRequire(import.meta.resolve('jamiblossom'))('lunar-javascript') as { LunarUtil: { NAYIN: Record<string, string> } };
    const names = new Set(Object.entries(LunarUtil.NAYIN).flatMap(([pillar, name]) => (/^[甲乙丙丁戊己庚辛壬癸]/.test(pillar) ? [name] : [])));
    expect(names.size).toBe(30);
    const read = [...names].map(nayinKo);
    expect(read.every((label) => HANGUL.test(label))).toBe(true);
    expect(new Set(read).size).toBe(30);
    expect(nayinKo('海中金')).toBe('해중금');
  });

  it('12운성 열두 가지를 모두 한글로 읽는다', () => {
    // 한 날의 열두 시진이면 같은 일간이 열두 지지를 모두 만난다.
    const stages = ['00:40', '02:10', '04:20', '06:15', '08:30', '10:10', '12:20', '14:40', '16:10', '18:20', '20:30', '22:10'].map((time) =>
      stageKo(readingOf({ calendar: 'solar', year: 1990, month: 1, day: 1, leapMonth: false, time, gender: 'female' }).hour!.diShi),
    );
    expect(new Set(stages).size).toBe(12);
    expect(stages.every((label) => HANGUL.test(label))).toBe(true);
    expect(stageKo('长生')).toBe('장생');
    // Twelve charts: jamiblossom draws the whole 자미두수 chart for each, which a busy runner takes its time over.
  }, 30_000);

  it('표에 없는 이름은 받은 대로 보여 준다', () => {
    expect(stageKo('旺')).toBe('旺');
    expect(nayinKo('')).toBe('');
  });
});
