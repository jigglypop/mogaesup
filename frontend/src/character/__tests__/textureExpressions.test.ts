import { MeshStandardMaterial, Texture } from 'three';
import { describe, expect, it } from 'vitest';

import { prepareExpressionMaterial } from '../texture-expressions';

/** A body's skin material the way the glTF loader hands it over, marked as carrying the expression atlas. */
const skin = () => Object.assign(new MeshStandardMaterial(), { map: new Texture(), userData: { factory_expression_uv: 'expression-base-color-uv-v1' } });

describe('표정 재질의 프로그램 키', () => {
  it('같은 플래그를 가진 몸 재질끼리도 서로 다르다', () => {
    const [covered, visible] = [skin(), skin()];
    prepareExpressionMaterial(covered);
    prepareExpressionMaterial(visible);
    expect(covered.customProgramCacheKey()).not.toBe(visible.customProgramCacheKey());
    expect(covered.customProgramCacheKey()).toContain(covered.uuid);
  });

  it('다시 준비해도 키가 쌓이지 않는다', () => {
    const material = skin();
    prepareExpressionMaterial(material);
    const first = material.customProgramCacheKey();
    prepareExpressionMaterial(material);
    const second = material.customProgramCacheKey();
    expect(second).not.toBe(first);
    expect(second.length).toBeLessThanOrEqual(first.length + 4);
  });

  it('표정 UV가 없는 재질은 건드리지 않는다', () => {
    const material = Object.assign(new MeshStandardMaterial(), { map: new Texture() });
    const before = material.customProgramCacheKey();
    prepareExpressionMaterial(material);
    expect(material.customProgramCacheKey()).toBe(before);
  });
});
