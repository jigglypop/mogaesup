import { describe, expect, it } from 'vitest';

import { PROPS } from '../decor';
import { PICKED_BY, propBuild } from '../scene/Decor';

describe('놓는 소품', () => {
  it('소품마다 무언가 서고, 단단한 면이 없는 것은 누를 자리가 따로 있다', () => {
    for (const { ref } of PROPS) {
      const build = propBuild(ref);
      expect(build.meshes.length + build.sprigs.length, ref).toBeGreaterThan(0);
      if (build.meshes.length === 0) expect(PICKED_BY[ref], ref).toBeDefined();
    }
  });

  it('울타리와 길 한 칸은 2미터 남짓이고 섬 위에 선다', () => {
    for (const ref of ['fence-wood', 'fence-bamboo', 'stone-wall', 'path-stone', 'path-wood'] as const) {
      const build = propBuild(ref);
      let least = Infinity;
      let most = -Infinity;
      for (const { geometry } of build.meshes) {
        geometry.computeBoundingBox();
        least = Math.min(least, geometry.boundingBox!.min.x);
        most = Math.max(most, geometry.boundingBox!.max.x);
      }
      expect(most - least, ref).toBeGreaterThan(1.8);
      expect(most - least, ref).toBeLessThan(2.8);
    }
  });
});
