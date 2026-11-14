import { describe, expect, it } from 'vitest';

import { balanceOf, branchElement, controls, ELEMENTS, elementLabel, generates, hangulOf, relationOf, stemElement } from '../elements';

describe('오행', () => {
  it('상생은 목→화→토→금→수→목으로 돈다', () => {
    expect(ELEMENTS.map(generates)).toEqual(['fire', 'earth', 'metal', 'water', 'wood']);
  });

  it('상극은 목→토→수→화→금→목으로 돈다', () => {
    expect(ELEMENTS.map(controls)).toEqual(['earth', 'metal', 'water', 'wood', 'fire']);
  });

  it('두 오행의 관계를 방향과 함께 말한다', () => {
    expect(relationOf('wood', 'wood')).toBe('same');
    expect(relationOf('wood', 'fire')).toBe('generates');
    expect(relationOf('fire', 'wood')).toBe('generated');
    expect(relationOf('wood', 'earth')).toBe('controls');
    expect(relationOf('earth', 'wood')).toBe('controlled');
  });

  it('천간과 지지의 오행과 읽는 소리', () => {
    expect([...'甲乙丙丁戊己庚辛壬癸'].map(stemElement)).toEqual(['wood', 'wood', 'fire', 'fire', 'earth', 'earth', 'metal', 'metal', 'water', 'water']);
    expect([...'子丑寅卯辰巳午未申酉戌亥'].map(branchElement)).toEqual(
      ['water', 'earth', 'wood', 'wood', 'earth', 'fire', 'fire', 'earth', 'metal', 'metal', 'earth', 'water'],
    );
    expect(stemElement('子')).toBeNull();
    expect(branchElement('甲')).toBeNull();
    expect([...'丁酉'].map(hangulOf).join('')).toBe('정유');
    expect(elementLabel('fire')).toBe('화(火)');
  });
});

describe('오행 분포', () => {
  it('여덟 글자를 세고, 합이 100인 정수 비율로 나눈다', () => {
    const balance = balanceOf([...'木木木木火火土水']);
    expect(balance.counts).toEqual({ wood: 4, fire: 2, earth: 1, metal: 0, water: 1 });
    expect(balance.total).toBe(8);
    expect(balance.percent).toEqual({ wood: 50, fire: 25, earth: 13, metal: 0, water: 12 });
    expect(Object.values(balance.percent).reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(balance.dominant).toBe('wood');
    expect(balance.secondary).toBe('fire');
    expect(balance.lacking).toEqual(['metal']);
  });

  it('여섯 글자(시주 없음)도 합이 100이다', () => {
    const balance = balanceOf([...'火火火土木水']);
    expect(balance.percent).toEqual({ wood: 17, fire: 50, earth: 17, metal: 0, water: 16 });
    expect(Object.values(balance.percent).reduce((sum, value) => sum + value, 0)).toBe(100);
  });

  it('글자 수가 같으면 일간, 월지의 오행을 앞세운다', () => {
    const characters = [...'木木火火土土金水'];
    expect(balanceOf(characters).dominant).toBe('wood');
    expect(balanceOf(characters, ['earth', 'fire']).ranked.slice(0, 3)).toEqual(['earth', 'fire', 'wood']);
    expect(balanceOf(characters, ['water', 'fire']).dominant).toBe('fire');
  });

  it('한 오행뿐이면 다음 오행이 없다', () => {
    const balance = balanceOf([...'土土土土土土土土']);
    expect(balance.secondary).toBeNull();
    expect(balance.percent.earth).toBe(100);
    expect(balance.lacking).toEqual(['wood', 'fire', 'metal', 'water']);
  });

  it('오행이 아닌 글자는 세지 않는다', () => {
    expect(balanceOf(['木', '？', '']).total).toBe(1);
    expect(balanceOf([]).percent).toEqual({ wood: 0, fire: 0, earth: 0, metal: 0, water: 0 });
  });
});
