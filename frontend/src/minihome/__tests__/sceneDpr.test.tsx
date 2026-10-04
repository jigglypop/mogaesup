import { Children, isValidElement, type ReactNode } from 'react';

import type { RapierRigidBody } from '@react-three/rapier';
import type { Group } from 'three';
import { describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { Scene } from '../Scene';

// No GPU here: the canvas records the `dpr` it is given and runs only the scene's report of the ratio, which reads the
// ratio the engine's quality controller set (`engine.dpr`).
const engine = vi.hoisted(() => ({ dpr: 1.25, given: [] as unknown[] }));
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, dpr }: { children: ReactNode; dpr?: unknown }) => {
    engine.given.push(dpr);
    return Children.toArray(children).filter(
      (child) => isValidElement(child) && typeof child.type === 'function' && child.type.name === 'ReportDpr',
    );
  },
  useThree: (select: (state: { viewport: { dpr: number } }) => unknown) => select({ viewport: { dpr: engine.dpr } }),
}));

describe('섬 캔버스의 화소 비율', () => {
  it('엔진이 정한 비율을 캔버스에 돌려주어, 캔버스가 다시 그려져도 R3F 기본값으로 되돌리지 않는다', async () => {
    const body = { current: null! as RapierRigidBody };
    const visual = { current: null! as Group };
    const scene = (quality: 'auto' | 'low') => (
      <Scene quality={quality} postProcessing={false} idleThrottle playerRef={body} visualRotationRef={visual} />
    );
    const { rerender, unmount } = await mount(scene('auto'));
    expect(engine.given).toEqual([[1, 1.5], 1.25]);

    // The same settings again: the memoized scene leaves the canvas alone.
    await rerender(scene('auto'));
    expect(engine.given).toHaveLength(2);
    // Other settings render the canvas again, still with the engine's ratio.
    await rerender(scene('low'));
    expect(engine.given).toEqual([[1, 1.5], 1.25, 1.25]);
    await unmount();
  });
});
