import { describe, expect, it } from 'vitest';

import { flagDesignOf, itemId, MOST_ITEMS, PROPS } from '../decor';
import { ziweiOf } from '../ziwei';

describe('섬 꾸미기', () => {
  it('내 깃발은 명궁의 첫 주성과 오행국의 오행이다', () => {
    const birth = { calendar: 'solar', year: 1988, month: 6, day: 14, leapMonth: false, time: '07:30', gender: 'female' } as const;
    const design = flagDesignOf(birth)!;
    const chart = ziweiOf(birth)!;
    const majors = chart.palaces[chart.soul]!.stars.major.map((star) => star.name);
    expect(design.star).toBe(majors[0] ?? '공궁');
    expect(design.element).toBe(chart.bureau.element);
    expect(['자미', '천기', '태양', '무곡', '천동', '염정', '천부', '태음', '탐랑', '거문', '천상', '천량', '칠살', '파군', '공궁']).toContain(design.star);
  });

  it('놓을 수 있는 소품은 서버가 아는 열두 가지이고, 섬 하나에 스물넷까지 놓는다', () => {
    expect(PROPS.map((prop) => prop.ref)).toEqual(['lantern', 'bench', 'jar', 'pot', 'barrel', 'woodpile', 'table', 'parasol', 'well', 'bush', 'rock', 'tree']);
    expect(MOST_ITEMS).toBe(24);
    const ids = new Set(Array.from({ length: 200 }, itemId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
  });
});
