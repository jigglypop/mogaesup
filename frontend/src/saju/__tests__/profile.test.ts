import { describe, expect, it } from 'vitest';

import { pillarsOf } from '../engine';
import { choiceOf, HOUSE_NAME, houseName, profileOf, roofOf, withHouse } from '../profile';
import { PEOPLE, personOf } from './people';

const profile = (id: string) => profileOf(personOf(id).birth);
const chart = (id: string) => pillarsOf(profile(id).reading).map(({ pillar }) => pillar.cn).join(' ');

describe('네 사람의 사주', () => {
  it('네 사람의 사주와 오행 분포', () => {
    expect(chart('sol')).toBe('己巳 丙寅 甲寅 乙亥');
    expect(profile('sol').balance.counts).toEqual({ wood: 4, fire: 2, earth: 1, metal: 0, water: 1 });
    expect(chart('noeul')).toBe('丁卯 丙午 丁酉 甲辰');
    expect(profile('noeul').balance.counts).toEqual({ wood: 2, fire: 4, earth: 1, metal: 1, water: 0 });
    expect(chart('bori')).toBe('戊辰 辛酉 己丑 丙寅');
    expect(profile('bori').balance.counts).toEqual({ wood: 1, fire: 1, earth: 4, metal: 2, water: 0 });
    expect(chart('garam')).toBe('壬申 辛亥 壬辰 壬寅');
    expect(profile('garam').balance.counts).toEqual({ wood: 1, fire: 0, earth: 1, metal: 2, water: 4 });
  });

  it('집은 가장 많은 오행을 따르고, 다음 오행과 일간이 마당에 더해진다', () => {
    expect(PEOPLE.map((resident) => profileOf(resident.birth).house)).toEqual([
      { style: 'wood', accent: 'fire', symbol: 'tree' },
      { style: 'fire', accent: 'wood', symbol: 'candle' },
      { style: 'earth', accent: 'metal', symbol: 'field' },
      { style: 'water', accent: 'metal', symbol: 'lighthouse' },
    ]);
    expect(HOUSE_NAME[profile('noeul').house.style]).toBe('붉은 벽돌집');
  });

  it('주인이 고른 집은 모양과 지붕과 장식 색을 바꾸고, 같은 선택이면 같은 프로필이다', () => {
    const sol = profile('sol');
    expect(withHouse(sol, null)).toBe(sol);
    const chosen = withHouse(sol, { style: 'metal', roof: 'dome', accent: null });
    expect(chosen.house).toEqual({ style: 'metal', accent: null, symbol: 'tree', roof: 'dome' });
    expect(withHouse(sol, { style: 'metal', roof: 'dome', accent: null })).toBe(chosen);
    expect(chosen.reading).toBe(sol.reading);
    expect(houseName(chosen.house)).toBe('은빛 기와집 · 천문 돔');
    expect(roofOf(sol.house)).toBe('gables');
    expect(choiceOf(sol.house)).toEqual({ style: 'wood', roof: 'gables', accent: 'fire' });
  });

  it('일간을 한 줄로 말한다', () => {
    expect(profile('noeul').badge).toBe('따뜻한 촛불 같은 정화(丁火) 일간');
    expect(profile('sol').badge).toBe('곧게 뻗는 큰 나무 같은 갑목(甲木) 일간');
    expect(profile('bori').dayMaster).toEqual({ stem: '己', label: '기토(己土)', element: 'earth' });
    expect(profile('garam').badge).toBe('깊고 넓은 바다 같은 임수(壬水) 일간');
  });

  it('수호 강아지는 일주가 정하고, 신살이 준 것을 지닌다', () => {
    expect(profile('sol').guardian).toEqual({
      dog: '09',
      name: '메달 강아지',
      pillar: '갑인(甲寅)',
      charms: [
        { charm: 'bundle', label: '역마의 봇짐' },
        { charm: 'books', label: '문창의 책' },
      ],
    });
    expect(profile('noeul').guardian.name).toBe('왕관 강아지');
    expect(profile('noeul').guardian.charms.map((item) => item.charm)).toEqual(['star', 'blossom', 'scarf']);
    expect(profile('bori').guardian.name).toBe('곰인형 강아지');
    expect(profile('bori').guardian.charms.map((item) => item.charm)).toEqual(['blossom', 'ribbon', 'bundle']);
    expect(profile('garam').guardian.name).toBe('목도리 강아지');
    expect(profile('garam').guardian.charms.map((item) => item.charm)).toEqual(['cape', 'canopy', 'bundle']);
  });

  it('시를 모르는 사주는 여섯 글자로 센다', () => {
    const known = profileOf(personOf('sol').birth);
    const unknown = profileOf({ ...personOf('sol').birth, time: null });
    // 시주 乙亥(木水)가 빠진다.
    expect(known.balance.total).toBe(8);
    expect(unknown.balance.total).toBe(6);
    expect(unknown.balance.counts).toEqual({ wood: 3, fire: 2, earth: 1, metal: 0, water: 0 });
    expect(unknown.balance.lacking).toEqual(['metal', 'water']);
    expect(unknown.house.style).toBe('wood');
    expect(unknown.guardian.name).toBe('메달 강아지');
    // 역마는 시지(亥)에 있었다.
    expect(unknown.guardian.charms.map((item) => item.charm)).not.toContain('bundle');
  });
});
