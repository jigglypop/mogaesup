import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { flagDesignOf, itemId, MOST_ITEMS, PROP_GROUPS, PROPS } from '../decor';
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

  it('소품은 서버가 아는 이름만 쓰고 선반마다 나뉘며, 섬 하나에 예순넷까지 놓는다', () => {
    const server = readFileSync(resolve(__dirname, '../../../../server/src/saju_decor.rs'), 'utf8');
    const known = server.slice(server.indexOf('const PROPS'), server.indexOf('];', server.indexOf('const PROPS')));
    for (const prop of PROPS) expect(known).toContain(`"${prop.ref}"`);
    expect(new Set(PROPS.map((prop) => prop.ref)).size).toBe(PROPS.length);
    for (const group of PROP_GROUPS) expect(PROPS.some((prop) => prop.group === group.id)).toBe(true);
    expect(MOST_ITEMS).toBe(64);
    expect(server).toContain('const MAX_ITEMS: usize = 64;');
    const ids = new Set(Array.from({ length: 200 }, itemId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
  });
});
