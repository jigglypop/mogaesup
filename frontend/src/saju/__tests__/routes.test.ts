import { describe, expect, it } from 'vitest';

import { chartPath, editPath, homePath, isMinihomePage, movedPath, routeOf, villagePath, waveOf, ziweiPath } from '../routes';

describe('미니홈피 주소', () => {
  const owner = { owner: true, built: true };
  const visitor = { owner: false, built: true };

  it('뿌리는 집이고, 사주보기는 지은 집에서만 연다', () => {
    expect(routeOf('sol', '', '', visitor)).toEqual({ kind: 'home', tab: 'home' });
    expect(routeOf('sol', '', '?view=chart', visitor)).toEqual({ kind: 'home', tab: 'chart' });
    expect(routeOf('sol', '', '?view=ziwei', visitor)).toEqual({ kind: 'home', tab: 'ziwei' });
    expect(routeOf('sol', '', '?view=stars', visitor)).toEqual({ kind: 'home', tab: 'home' });
    // 아직 짓지 않은 집에는 읽을 사주가 없다.
    expect(routeOf('sol', '', '?view=chart', { owner: true, built: false })).toEqual({ kind: 'home', tab: 'home' });
    expect(routeOf('sol', '', '?view=ziwei', { owner: true, built: false })).toEqual({ kind: 'home', tab: 'home' });
  });

  it('마을은 누구에게나 열린다', () => {
    expect(routeOf('sol', 'village', '', visitor)).toEqual({ kind: 'village' });
    expect(routeOf('sol', 'village', '', { owner: false, built: false })).toEqual({ kind: 'village' });
  });

  it('사주 다시 입력은 집을 지은 주인만 연다', () => {
    expect(routeOf('sol', 'edit', '', owner)).toEqual({ kind: 'edit' });
    expect(routeOf('sol', 'edit', '', visitor)).toEqual({ kind: 'redirect', to: '/@sol' });
    // 짓지 않은 주인에게는 집의 첫 화면이 집 짓기다.
    expect(routeOf('sol', 'edit', '', { owner: true, built: false })).toEqual({ kind: 'redirect', to: '/@sol' });
  });

  it('없는 주소는 집으로 돌린다', () => {
    expect(routeOf('sol', 'village/extra', '', owner)).toEqual({ kind: 'redirect', to: '/@sol' });
    expect(routeOf('sol', 'nowhere', '', owner)).toEqual({ kind: 'redirect', to: '/@sol' });
    expect(isMinihomePage('')).toBe(true);
    expect(isMinihomePage('village')).toBe(true);
    expect(isMinihomePage('edit')).toBe(true);
    expect(isMinihomePage('nowhere')).toBe(false);
  });

  it('집, 사주보기, 마을, 다시 입력의 주소', () => {
    expect(homePath('sol')).toBe('/@sol');
    expect(chartPath('sol')).toBe('/@sol?view=chart');
    expect(ziweiPath('sol')).toBe('/@sol?view=ziwei');
    expect(villagePath('sol')).toBe('/@sol/village');
    expect(editPath('sol')).toBe('/@sol/edit');
  });

  it('사주 마을의 옛 주소는 내 미니홈피의 같은 쪽으로 간다', () => {
    expect(movedPath('sol', '', '')).toBe('/@sol');
    expect(movedPath('sol', '', '?view=chart')).toBe('/@sol?view=chart');
    expect(movedPath('sol', 'village', '')).toBe('/@sol/village');
    expect(movedPath('sol', 'edit', '')).toBe('/@sol/edit');
    // 샘플 주민의 집은 이제 없다.
    expect(movedPath('sol', 'home/noeul', '?view=chart')).toBe('/@sol');
  });
});

describe('파도타기', () => {
  const ids = ['sol', 'noeul', 'bori', 'garam'];

  it('둘레의 집 가운데 하나로 가고, 내 집으로는 가지 않는다', () => {
    expect(waveOf(ids, null, () => 0)).toBe('sol');
    expect(waveOf(ids, null, () => 0.99)).toBe('garam');
    expect(waveOf(ids, 'sol', () => 0)).toBe('noeul');
    expect(waveOf(ids, 'garam', () => 0.99)).toBe('bori');
  });

  it('갈 집이 없으면 가지 않는다', () => {
    expect(waveOf([], null)).toBeNull();
    expect(waveOf(['sol'], 'sol')).toBeNull();
  });
});
