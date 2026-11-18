import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { dayOrnament, ELEMENT_PIECES, supplementElements } from '../elementalDecor';
import { balanceOf, ELEMENTS, STEMS, stemElement } from '../elements';
import { buildOrnament } from '../scene/ElementOrnament';

describe('일간 장식과 오행 장식', () => {
  beforeAll(() => vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null));

  it('여섯 글자에서 빠진 오행과 여덟 글자에서 공동으로 적은 오행을 모두 추천한다', () => {
    expect(supplementElements(balanceOf([...'木木火火金金']))).toEqual(['earth', 'water']);
    expect(supplementElements(balanceOf([...'木木火火土土金水']))).toEqual(['metal', 'water']);
  });

  it('열 가지 일간마다 그 오행으로 만든 다른 장식이 있다', () => {
    expect(new Set(STEMS.map((stem) => dayOrnament(stem)?.ref)).size).toBe(10);
    for (const stem of STEMS) expect(dayOrnament(stem)?.element).toBe(stemElement(stem));
  });

  it('각 오행의 세 장식에는 보관함 그림과 회전·염색 가능한 입체 모형이 있다', () => {
    for (const element of ELEMENTS) expect(ELEMENT_PIECES.filter((piece) => piece.element === element)).toHaveLength(3);
    for (const piece of ELEMENT_PIECES) {
      expect(existsSync(resolve('public', piece.image.slice(1)))).toBe(true);
      const meshColors = (color?: string) => {
        const { meshes } = buildOrnament(piece, color);
        expect(meshes.length).toBeGreaterThan(0);
        const result = meshes.map(({ geometry }) => {
          expect(geometry.getAttribute('position').array.every(Number.isFinite)).toBe(true);
          const colors = geometry.getAttribute('color').array.slice();
          geometry.dispose();
          return colors;
        });
        return result;
      };
      expect(meshColors('#763b67')).not.toEqual(meshColors());
    }
  });
});
