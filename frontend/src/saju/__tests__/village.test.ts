import { describe, expect, it } from 'vitest';

import { profileOf } from '../profile';
import { PLOT_REACH, plotsOf } from '../village';
import { PEOPLE } from './people';

describe('마을 자리', () => {
  const R = PLOT_REACH;

  it('이웃은 제 오행의 방위에 자리를 잡고, 토는 남은 자리에 든다', () => {
    const neighbours = PEOPLE.map((resident) => ({ id: resident.id, element: profileOf(resident.birth).balance.dominant }));
    expect(plotsOf(neighbours)).toEqual([
      { id: 'sol', x: R, z: 0 },
      { id: 'noeul', x: 0, z: R },
      { id: 'bori', x: -R, z: 0 },
      { id: 'garam', x: 0, z: -R },
    ]);
  });

  it('같은 오행이 겹치면 다음 빈자리로 간다', () => {
    const plots = plotsOf([
      { id: 'a', element: 'fire' },
      { id: 'b', element: 'fire' },
      { id: 'c', element: 'metal' },
    ]);
    expect(plots).toEqual([
      { id: 'b', x: R, z: 0 },
      { id: 'a', x: 0, z: R },
      { id: 'c', x: -R, z: 0 },
    ]);
    expect(new Set(plots.map((plot) => `${plot.x},${plot.z}`)).size).toBe(3);
  });

  it('자리보다 이웃이 많으면 자리만큼만 놓는다', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ id: `n${index}`, element: 'earth' as const }));
    const plots = plotsOf(many);
    expect(plots).toHaveLength(8);
    expect(new Set(plots.map((plot) => `${plot.x},${plot.z}`)).size).toBe(8);
    expect(plots.every((plot) => plot.x !== 0 || plot.z !== 0)).toBe(true);
  });
});
