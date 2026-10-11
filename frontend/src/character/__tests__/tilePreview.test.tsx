import { act } from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { made } = vi.hoisted(() => ({ made: [] as { toneMapping: number }[] }));
vi.mock('three/webgpu', () => ({
  WebGPURenderer: class {
    init = async () => {};
    backend = { isWebGPUBackend: true };
    toneMapping = 0;
    domElement: HTMLCanvasElement;
    constructor(options: { canvas: HTMLCanvasElement }) { this.domElement = options.canvas; made.push(this); }
    render() {}
    setPixelRatio() {}
    setSize() {}
    dispose() {}
  },
}));

import { _roots } from '@react-three/fiber';
import * as THREE from 'three';

import { mount } from '../../__tests__/mount';
import TilePreview from '../studio/TilePreview';

const settle = () => act(async () => { for (let round = 0; round < 10; round++) await Promise.resolve(); });

describe('타일 3D 재질 미리보기', () => {
  afterEach(() => { vi.unstubAllGlobals(); made.length = 0; });

  it('크기나 보이는 상태가 바뀌어도 그리는 방식과 화소 비율 상한을 지키고, 톤 매핑은 Neutral로 둔다', async () => {
    const resized: (() => void)[] = [], shown: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized.push(callback); } observe() {} disconnect() {} });
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { shown.push(callback); }
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal('devicePixelRatio', 3);
    const view = await mount(<TilePreview tile={{ id: 'grass', surface: 'grass', size: 512, seed: 1, gpu: { estimated_bytes_with_mips: 0 }, artifacts: [] }} />);
    // The first observer is the gate's, which starts the preview; the second is the preview's own.
    await act(async () => shown[0]!([{ isIntersecting: true }]));
    await settle();
    const state = () => _roots.get(view.container.querySelector('canvas')!)!.store.getState();
    expect(made[0]!.toneMapping).toBe(THREE.NeutralToneMapping);
    expect([state().frameloop, state().viewport.dpr]).toEqual(['demand', 1.5]);

    await act(async () => resized[0]!());
    expect([state().frameloop, state().viewport.dpr]).toEqual(['demand', 1.5]);
    await act(async () => shown[1]!([{ isIntersecting: false }]));
    expect([state().frameloop, state().viewport.dpr]).toEqual(['never', 1.5]);
    await act(async () => resized[0]!());
    expect([state().frameloop, state().viewport.dpr]).toEqual(['never', 1.5]);
    await act(async () => shown[1]!([{ isIntersecting: true }]));
    expect([state().frameloop, state().viewport.dpr]).toEqual(['demand', 1.5]);
    await view.unmount();
  });
});
