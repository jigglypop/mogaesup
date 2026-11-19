import { describe, expect, it } from 'vitest';

import { containedSize } from '../scene/contain';

describe('전광판 사진', () => {
  it('가로로 긴 사진은 높이를 줄여 화면에 담고, 세로로 긴 사진은 너비를 줄인다', () => {
    const wide = containedSize(1600, 400, 3.2, 1.8);
    const tall = containedSize(400, 1600, 3.2, 1.8);
    expect(wide.w).toBeCloseTo(3.2);
    expect(wide.h).toBeCloseTo(0.8);
    expect(wide.w / wide.h).toBeCloseTo(4);
    expect(tall.h).toBeCloseTo(1.8);
    expect(tall.w / tall.h).toBeCloseTo(0.25);
    expect(containedSize(320, 180, 3.2, 1.8)).toEqual({ w: 3.2, h: 1.8 });
  });
});
