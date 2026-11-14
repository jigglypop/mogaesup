import { describe, expect, it } from 'vitest';

import { frameOf, onScreen, zoomOf } from '../scene/frames';
import { pictureFileName } from '../snapshot';
import { PLOT_REACH } from '../village';

describe('카메라의 틀', () => {
  it('한 집은 그 섬을 가운데에 둔다', () => {
    const frame = frameOf([{ x: PLOT_REACH, z: 0 }]);
    expect(frame.target).toEqual([PLOT_REACH, 1.5, 0]);
    expect(frame.halfWidth).toBe(8);
    expect(frame.halfHeight).toBe(7);
  });

  it('두 집은 그 사이를 가운데에 두고 둘을 다 담는다', () => {
    const one = frameOf([{ x: 0, z: 0 }]);
    const two = frameOf([{ x: 0, z: 0 }, { x: PLOT_REACH, z: 0 }]);
    expect(two.target).toEqual([PLOT_REACH / 2, 1.5, 0]);
    expect(two.halfWidth).toBeCloseTo(one.halfWidth + (PLOT_REACH / 2) * Math.SQRT1_2, 5);
    expect(two.halfHeight).toBeGreaterThan(one.halfHeight);
  });

  it('마을은 네 방위의 집을 모두 담는다', () => {
    const R = PLOT_REACH;
    const village = frameOf([{ x: 0, z: 0 }, { x: R, z: 0 }, { x: 0, z: R }, { x: -R, z: 0 }, { x: 0, z: -R }]);
    expect(village.target).toEqual([0, 1.5, 0]);
    expect(village.halfWidth).toBeCloseTo(8 + R * Math.SQRT1_2, 5);
    // 화면에서 동쪽 집은 오른쪽 아래, 북쪽 집은 오른쪽 위다.
    expect(onScreen({ x: R, z: 0 }).right).toBeGreaterThan(0);
    expect(onScreen({ x: R, z: 0 }).up).toBeLessThan(0);
    expect(onScreen({ x: 0, z: -R }).right).toBeGreaterThan(0);
    expect(onScreen({ x: 0, z: -R }).up).toBeGreaterThan(0);
  });

  it('집이 없어도 틀은 있다', () => {
    expect(frameOf([])).toEqual({ target: [0, 1.5, 0], halfWidth: 8, halfHeight: 7 });
  });

  it('화면에 맞는 배율은 좁은 쪽이 정한다', () => {
    const frame = frameOf([{ x: 0, z: 0 }]);
    expect(zoomOf(frame, 800, 700)).toBe(50);
    expect(zoomOf(frame, 320, 700)).toBe(20);
  });
});

describe('저장하는 그림의 이름', () => {
  it('파일 이름에 못 쓰는 글자는 뺀다', () => {
    expect(pictureFileName('가온')).toBe('가온-집.png');
    expect(pictureFileName(' a/b:c*?"<>| ')).toBe('abc-집.png');
    expect(pictureFileName('///')).toBe('사주-집.png');
  });
});
