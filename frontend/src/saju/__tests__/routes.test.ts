import { describe, expect, it } from 'vitest';

import { chartPath, homePath, nextWave, routeOf } from '../routes';

describe('사주 마을 주소', () => {
  it('뿌리는 내 집이고, 사주보기는 집이 있을 때만 연다', () => {
    expect(routeOf('', '', true)).toEqual({ kind: 'mine', chart: false });
    expect(routeOf('', '?view=chart', true)).toEqual({ kind: 'mine', chart: true });
    // 집이 없으면 집 짓는 카드가 나온다.
    expect(routeOf('', '?view=chart', false)).toEqual({ kind: 'mine', chart: false });
  });

  it('마을과 이웃의 집', () => {
    expect(routeOf('village', '', false)).toEqual({ kind: 'village' });
    expect(routeOf('home/noeul', '', false)).toEqual({ kind: 'home', id: 'noeul', chart: false });
    expect(routeOf('home/noeul/', '?view=chart', true)).toEqual({ kind: 'home', id: 'noeul', chart: true });
  });

  it('고치기는 집이 있어야 하고, 없으면 집 짓기로 간다', () => {
    expect(routeOf('edit', '', true)).toEqual({ kind: 'edit' });
    expect(routeOf('edit', '', false)).toEqual({ kind: 'redirect', to: '/saju' });
  });

  it('없는 주소는 갈 곳으로 돌린다', () => {
    expect(routeOf('home/me', '', true)).toEqual({ kind: 'redirect', to: '/saju' });
    expect(routeOf('home/nobody', '', true)).toEqual({ kind: 'redirect', to: '/saju/village' });
    expect(routeOf('home', '', true)).toEqual({ kind: 'redirect', to: '/saju' });
    expect(routeOf('village/extra', '', true)).toEqual({ kind: 'redirect', to: '/saju' });
    expect(routeOf('nowhere', '', true)).toEqual({ kind: 'redirect', to: '/saju' });
  });

  it('집과 사주보기의 주소', () => {
    expect(homePath('me')).toBe('/saju');
    expect(homePath('sol')).toBe('/saju/home/sol');
    expect(chartPath('me')).toBe('/saju?view=chart');
    expect(chartPath('sol')).toBe('/saju/home/sol?view=chart');
  });
});

describe('파도타기', () => {
  const ids = ['sol', 'noeul', 'bori', 'garam'];

  it('다음 이웃으로 가고, 끝에서는 처음으로 돈다', () => {
    expect(nextWave(ids, 'sol')).toBe('noeul');
    expect(nextWave(ids, 'garam')).toBe('sol');
  });

  it('이웃의 집 밖에서는 첫 이웃으로 간다', () => {
    expect(nextWave(ids, null)).toBe('sol');
    expect(nextWave(ids, 'me')).toBe('sol');
  });

  it('갈 이웃이 없으면 가지 않는다', () => {
    expect(nextWave([], null)).toBeNull();
    expect(nextWave(['sol'], 'sol')).toBeNull();
  });
});
