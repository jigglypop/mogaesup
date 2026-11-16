import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { init, gpu, world } = vi.hoisted(() => ({
  init: vi.fn<() => Promise<void>>(),
  // A test that needs a working renderer gives it a backend; without one, starting it fails.
  gpu: { backend: undefined as { isWebGPUBackend: boolean } | undefined, made: [] as { toneMapping: number }[] },
  world: vi.fn((_props: { urls: { characterUrl: string } }) => null),
}));
vi.mock('three/webgpu', () => ({
  WebGPURenderer: class {
    init = init;
    backend = gpu.backend;
    toneMapping = 0;
    constructor() { gpu.made.push(this); }
    render() {}
    setClearColor() {}
    setPixelRatio() {}
    setSize() {}
    dispose() {}
  },
}));
// The engine's world does not run here: the stand-in records what the viewer hands it.
vi.mock('gaesup-world', async (original) => ({ ...await original<typeof import('gaesup-world')>(), GaesupWorld: world }));

import { _roots } from '@react-three/fiber';
import * as THREE from 'three';

import { ModelViewer } from '../viewer';

const watcher = class {
  observe() {}
  disconnect() {}
};
const badge = (container: HTMLElement) => container.querySelector('.renderer-badge')?.textContent;
/** `load` calls this once the model is parsed; there is no model to parse here. */
const initialize = (viewer: ModelViewer) => (viewer as unknown as { initialize(): Promise<void> }).initialize();

describe('렌더러 표시', () => {
  let container: HTMLElement;
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', watcher);
    vi.stubGlobal('IntersectionObserver', watcher);
    container = document.body.appendChild(document.createElement('div'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    init.mockReset();
    gpu.backend = undefined; gpu.made.length = 0; world.mockClear();
    container.remove();
  });

  it('시작하는 동안은 초기화 중이라고 알린다', () => {
    const viewer = new ModelViewer(container, 'studio');
    expect(badge(container)).toBe('WebGPU 초기화 중');
    expect(container.dataset['renderer']).toBeUndefined();
    viewer.dispose();
  });

  it('WebGPU 초기화가 실패하면 초기화 중에 머물지 않고 실패를 보인다', async () => {
    init.mockRejectedValue(new Error('WebGPU is not supported'));
    const viewer = new ModelViewer(container, 'studio');
    await expect(initialize(viewer)).rejects.toThrow('WebGPU is not supported');
    expect(container.dataset['renderer']).toBe('error');
    expect(badge(container)).toBe('렌더러 초기화 실패');
    viewer.dispose();
  });

  it('다시 시도하는 동안은 다시 초기화 중이라고 알린다', async () => {
    init.mockRejectedValueOnce(new Error('first'));
    const viewer = new ModelViewer(container, 'studio');
    await expect(initialize(viewer)).rejects.toThrow('first');
    await Promise.resolve();

    let finish!: () => void;
    init.mockReturnValueOnce(new Promise<void>((done) => (finish = done)));
    const retry = initialize(viewer);
    expect(badge(container)).toBe('WebGPU 초기화 중');
    expect(container.dataset['renderer']).toBeUndefined();
    finish();
    // The stub has no backend or canvas for a real root, so this try fails too, and says so.
    await retry.catch(() => undefined);
    expect(container.dataset['renderer']).toBe('error');
    viewer.dispose();
  });

  it('크기나 보이는 상태가 바뀌어도 그리는 방식과 화소 비율 상한을 지키고, 톤 매핑은 Neutral로 둔다', async () => {
    const resized: (() => void)[] = [], shown: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
    vi.stubGlobal('ResizeObserver', class extends watcher { constructor(callback: () => void) { super(); resized.push(callback); } });
    vi.stubGlobal('IntersectionObserver', class extends watcher {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { super(); shown.push(callback); }
    });
    vi.stubGlobal('devicePixelRatio', 3);
    gpu.backend = { isWebGPUBackend: true };
    const viewer = new ModelViewer(container, 'studio');
    await initialize(viewer);
    const state = () => _roots.get(container.querySelector('canvas')!)!.store.getState();
    expect(gpu.made[0]!.toneMapping).toBe(THREE.NeutralToneMapping);
    expect([state().frameloop, state().viewport.dpr]).toEqual(['demand', 1.5]);

    resized[0]!();
    expect([state().frameloop, state().viewport.dpr]).toEqual(['demand', 1.5]);
    shown[0]!([{ isIntersecting: false }]);
    expect([state().frameloop, state().viewport.dpr]).toEqual(['never', 1.5]);
    resized[0]!();
    expect([state().frameloop, state().viewport.dpr]).toEqual(['never', 1.5]);
    shown[0]!([{ isIntersecting: true }]);
    expect([state().frameloop, state().viewport.dpr]).toEqual(['demand', 1.5]);
    viewer.dispose();
  });

  it('이동 미리보기는 엔진에 모델 주소 대신 빈 glTF를 넘겨, 받아 확인한 모델을 엔진이 다시 받지 않는다', async () => {
    gpu.backend = { isWebGPUBackend: true };
    const body = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'body' }] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const made: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { made.push(blob as Blob); return `blob:${location.origin}/${made.length}`; });
    /** Loads the model and returns the character address the viewer hands the engine for it. */
    const handed = async (viewer: ModelViewer) => {
      const before = world.mock.calls.length;
      void viewer.load('/api/studio/body.glb').catch(() => undefined);
      await vi.waitFor(() => expect(world.mock.calls.length).toBeGreaterThan(before));
      return world.mock.calls.at(-1)![0].urls.characterUrl;
    };
    const first = new ModelViewer(container, 'world');
    const characterUrl = await handed(first);
    expect(await handed(first)).toBe(characterUrl);
    first.dispose();
    const second = new ModelViewer(container, 'world');
    expect(await handed(second)).toBe(characterUrl);
    second.dispose();

    // The engine fetches this address, and the site's connect-src allows blob: but not data:.
    expect(characterUrl).toMatch(/^blob:/);
    expect(made).toHaveLength(1);
    const reader = new FileReader();
    await new Promise(done => { reader.onload = done; reader.readAsText(made[0]!); });
    expect(JSON.parse(reader.result as string).nodes).toEqual([]);
  });
});
