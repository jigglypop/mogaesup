import { act, useEffect, useState, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { profileOf } from '../profile';
import type { IslandDecor } from '../scene/Decor';
import { usePhotoAsset } from '../scene/works';
import { personOf } from './people';

const scene = vi.hoisted(() => ({ frame: () => {}, load: () => {}, decor: vi.fn() }));
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: ReactNode }) => children,
  useFrame: (callback: () => void) => { scene.frame = callback; },
  useThree: () => document.createElement('canvas'),
}));
vi.mock('../scene/HomeEstate', () => ({ HomeEstate: () => null }));
vi.mock('../scene/Stage', () => ({
  createRenderer: () => ({}), SHADOWS: {},
  Scene: ({ children, onReady }: { children: ReactNode; onReady: () => void }) => {
    useEffect(onReady, [onReady]);
    return children;
  },
}));
vi.mock('../scene/Decor', () => ({
  DecorLayer: (props: IslandDecor & { selectedId: string | null }) => {
    const [loaded, setLoaded] = useState(false);
    scene.load = () => setLoaded(true);
    usePhotoAsset(loaded);
    scene.decor(props);
    return null;
  },
}));
const { Snapshot } = await import('../scene/Snapshot');
afterEach(() => vi.restoreAllMocks());

it('사진은 선택 표시 없이 촬영 당시 배치를 유지하고 모델이 올라온 뒤 세 프레임을 기다린다', async () => {
  const profile = profileOf(personOf('sol').birth);
  const decor: IslandDecor = { items: [{ id: 'bench', kind: 'prop', ref: 'bench', x: 4, z: 1, turn: 1, color: '#ba254c', scale: 1.5 }], flags: [], own: null, character: null };
  const shot = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: vi.fn() }) as unknown as CanvasRenderingContext2D);
  const page = await mount(<Snapshot profile={profile} decor={decor} onShot={shot} />);
  await page.rerender(<Snapshot profile={profile} decor={{ ...decor, items: [] }} onShot={shot} />);
  expect(scene.decor).toHaveBeenLastCalledWith({ ...decor, selectedId: null });
  for (let frame = 0; frame < 6; frame++) scene.frame();
  expect(shot).not.toHaveBeenCalled();
  await act(async () => scene.load());
  scene.frame();
  scene.frame();
  expect(shot).not.toHaveBeenCalled();
  scene.frame();
  scene.frame();
  expect(shot).toHaveBeenCalledExactlyOnceWith(expect.any(HTMLCanvasElement));
  await page.unmount();
});
