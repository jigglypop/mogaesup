import { describe, expect, it } from 'vitest';

import { readingOf, type Birth } from '../engine';
import { birthLinesOf, madeOn, reportFileName } from '../report/make';
import { ziweiOf } from '../ziwei';
import { personOf } from './people';

const linesOf = (birth: Birth) => birthLinesOf(birth, readingOf(birth));

describe('표지의 생년월일', () => {
  it('입력한 그대로 한 줄, 다른 달력의 날과 시진을 한 줄', () => {
    expect(linesOf(personOf('garam').birth)).toEqual(['양력 1992년 11월 12일 04:20 · 남성', '음력 1992년 10월 18일 · 인시']);
  });

  it('음력 생일은 양력 날짜를 함께 쓰고, 윤달은 윤을 붙인다', () => {
    const bori = personOf('bori').birth;
    const [year, month, day] = readingOf(bori).solarDate.split('-');
    expect(linesOf(bori)).toEqual(['음력 1988년 8월 21일 06:15 · 여성', `양력 ${year}년 ${month}월 ${day}일 · ${ziweiOf(bori)?.hour.name}`]);
    const leap: Birth = { calendar: 'lunar', year: 1993, month: 3, day: 15, leapMonth: true, time: null, gender: 'female' };
    expect(linesOf(leap)).toEqual(['음력 1993년 윤3월 15일 · 시간 모름 · 여성', '양력 1993년 5월 6일']);
  });

  it('태어난 시를 모르면 시진 없이 쓴다', () => {
    expect(linesOf({ ...personOf('garam').birth, time: null })).toEqual(['양력 1992년 11월 12일 · 시간 모름 · 남성', '음력 1992년 10월 18일']);
  });
});

describe('PDF 파일과 날짜', () => {
  it('<이름>-팔자피자.pdf, 파일 이름에 쓸 수 없는 글자는 뺀다', () => {
    expect(reportFileName('노을')).toBe('노을-팔자피자.pdf');
    expect(reportFileName(' 노/을:*? ')).toBe('노을-팔자피자.pdf');
    expect(reportFileName('  ')).toBe('팔자피자.pdf');
  });

  it('만든 날은 서울의 날짜로 쓴다', () => {
    expect(madeOn(new Date('2026-11-14T16:30:00Z'))).toBe('2026년 11월 15일');
    expect(madeOn(new Date('2026-11-14T14:30:00Z'))).toBe('2026년 11월 14일');
  });
});
