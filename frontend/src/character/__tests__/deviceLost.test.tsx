import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';

// A renderer and a React Three Fiber root that start, draw nothing and can lose their device on demand.
type FakeRenderer = { options: { alpha?: boolean; canvas?: HTMLCanvasElement }; onDeviceLost: (info: unknown) => void;
  dispose: ReturnType<typeof vi.fn>; setClearColor: ReturnType<typeof vi.fn> };
type FakeRoot = { canvas: HTMLCanvasElement; configure: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn>; unmount: ReturnType<typeof vi.fn> };
const made = vi.hoisted(() => ({ renderers: [] as FakeRenderer[], roots: [] as FakeRoot[] }));
vi.mock('three/webgpu', () => ({
  WebGPURenderer: class {
    backend = { isWebGPUBackend: true };
    onDeviceLost = (_info: unknown) => {};
    init = async () => {};
    dispose = vi.fn();
    setClearColor = vi.fn();
    constructor(public options: FakeRenderer['options']) {
      made.renderers.push(this as unknown as FakeRenderer);
    }
  },
}));
vi.mock('@react-three/fiber', async (original) => ({
  ...await original<typeof import('@react-three/fiber')>(),
  createRoot: (canvas: HTMLCanvasElement) => {
    const store = { getState: () => ({ invalidate: () => {} }) };
    const root: FakeRoot = { canvas, configure: vi.fn(async () => root), render: vi.fn(() => store), unmount: vi.fn() };
    made.roots.push(root);
    return root;
  },
}));

import { ModelViewer } from '../viewer';
import TilePreview, { TILE_DEVICE_RECOVERIES } from '../studio/TilePreview';

const watcher = class {
  constructor(private callback?: (entries: { isIntersecting: boolean }[]) => void) {}
  observe() { this.callback?.([{ isIntersecting: true }]); }
  disconnect() {}
};
const flush = () => act(async () => { for (let round = 0; round < 10; round++) await Promise.resolve(); });
const lose = (renderer: FakeRenderer) => act(async () => renderer.onDeviceLost({ api: 'WebGPU', message: 'device reset' }));
/** A model file: one scene with one empty node, as small as glTF allows. */
const modelFile = () => new Response(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'figure' }] }));
type Drawn = { props: { model: { gltf: unknown }; onReady(): void } };
/** What `root` was last asked to draw. */
const drawn = (root: FakeRoot | undefined) => root?.render.mock.calls.at(-1)?.[0] as Drawn | undefined;
/** Loses the device of the newest renderer, once it is in use, and waits for the viewer to act on it. */
async function loseNewest() {
  const count = made.renderers.length;
  await vi.waitFor(() => expect(made.roots).toHaveLength(count));
  await lose(made.renderers.at(-1)!);
  await flush();
}

describe('GPU 장치를 잃은 렌더러', () => {
  beforeEach(() => {
    made.renderers.length = 0; made.roots.length = 0;
    vi.stubGlobal('ResizeObserver', watcher);
    vi.stubGlobal('IntersectionObserver', watcher);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('캐릭터 뷰어는 새 캔버스에 렌더러를 다시 만들고, 거듭 잃으면 멈추고 알린다', async () => {
    vi.useFakeTimers();
    try {
      const container = document.body.appendChild(document.createElement('div'));
      const failure = vi.fn();
      const viewer = new ModelViewer(container, 'studio', { onFailure: failure });
      await (viewer as unknown as { initialize(): Promise<void> }).initialize();
      expect(container.dataset['renderer']).toBe('webgpu');
      const first = container.querySelector('canvas');

      await lose(made.renderers[0]!);
      await flush();
      expect(made.roots[0]!.unmount).toHaveBeenCalled();
      expect(made.renderers).toHaveLength(2);
      expect(container.querySelector('canvas')).not.toBe(first);
      expect(made.roots[1]!.canvas).toBe(container.querySelector('canvas'));
      expect(container.dataset['renderer']).toBe('webgpu');
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(made.renderers[0]!.dispose).toHaveBeenCalled();
      expect(failure).not.toHaveBeenCalled();

      await lose(made.renderers[1]!); await flush();
      await lose(made.renderers[2]!); await flush();
      expect(made.renderers).toHaveLength(3);
      expect(container.dataset['renderer']).toBe('error');
      expect(container.querySelector('.renderer-badge')?.textContent).toBe('렌더러 오류');
      expect(failure).toHaveBeenCalledOnce();
      expect(failure.mock.calls[0]![0].message).toContain('device reset');

      // Closing the viewer gives its device up on purpose: no loss to recover from.
      viewer.dispose();
      made.renderers.forEach(renderer => renderer.onDeviceLost({ api: 'WebGPU', message: 'destroyed' }));
      expect(made.renderers).toHaveLength(3);
      container.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('모델을 그리는 뷰어', () => {
    let container: HTMLElement;
    let viewer: ModelViewer | undefined;
    const failure = vi.fn();
    beforeEach(() => {
      container = document.body.appendChild(document.createElement('div'));
      failure.mockReset();
    });
    afterEach(() => {
      viewer?.dispose(); viewer = undefined;
      container.remove();
    });

    it('그린 뒤 장치를 잃으면 받아 둔 같은 모델을 새 렌더러로 다시 그린다', async () => {
      const download = vi.fn(async () => modelFile());
      vi.stubGlobal('fetch', download);
      viewer = new ModelViewer(container, 'card', { onFailure: failure });
      const loading = viewer.load('/models/fox.glb');
      await vi.waitFor(() => expect(drawn(made.roots[0])).toBeDefined());
      await act(async () => drawn(made.roots[0])!.props.onReady());
      await expect(loading).resolves.toEqual([]);
      const model = drawn(made.roots[0])!.props.model;

      await loseNewest();
      await vi.waitFor(() => expect(drawn(made.roots[1])).toBeDefined());
      expect(made.renderers).toHaveLength(2);
      expect(made.roots[1]!.canvas).toBe(container.querySelector('canvas'));
      expect(drawn(made.roots[1])!.props.model).toBe(model);
      expect(download).toHaveBeenCalledOnce();
      expect(container.dataset['renderer']).toBe('webgpu');
      expect(failure).not.toHaveBeenCalled();
    });

    it('파일을 받는 사이 장치를 잃으면 새 렌더러가 그 모델을 그려 불러오기를 끝낸다', async () => {
      let answer!: (response: Response) => void;
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
      viewer = new ModelViewer(container, 'card', { onFailure: failure });
      const loading = viewer.load('/models/fox.glb');
      await loseNewest();
      await vi.waitFor(() => expect(made.roots).toHaveLength(2));
      answer(modelFile());
      await vi.waitFor(() => expect(drawn(made.roots[1])).toBeDefined());
      expect(made.roots[0]!.render).not.toHaveBeenCalled();
      await act(async () => drawn(made.roots[1])!.props.onReady());
      await expect(loading).resolves.toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    });

    it('첫 그림을 기다리는 사이 장치를 잃어도 새 렌더러의 첫 그림으로 불러오기를 끝낸다', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => modelFile()));
      viewer = new ModelViewer(container, 'card', { onFailure: failure });
      const loading = viewer.load('/models/fox.glb');
      await vi.waitFor(() => expect(drawn(made.roots[0])).toBeDefined());
      await loseNewest();
      await vi.waitFor(() => expect(drawn(made.roots[1])).toBeDefined());
      await act(async () => drawn(made.roots[1])!.props.onReady());
      await expect(loading).resolves.toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    });

    it('파일을 받는 사이 장치를 거듭 잃으면 기다리지 않고 불러오기가 실패하며, 멈춘 뒤에는 새 렌더러를 만들지 않는다', async () => {
      let answer!: (response: Response) => void;
      const download = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
      vi.stubGlobal('fetch', download);
      viewer = new ModelViewer(container, 'card', { onFailure: failure });
      const loading = viewer.load('/models/fox.glb');
      loading.catch(() => {});
      for (let loss = 0; loss <= 2; loss++) await loseNewest();
      expect(made.renderers).toHaveLength(3);
      expect(container.dataset['renderer']).toBe('error');
      answer(modelFile());
      await expect(loading).rejects.toThrow('GPU 장치를 잃었어요 (device reset).');
      // The load reports it; nothing else hears of the same failure again.
      expect(failure).not.toHaveBeenCalled();
      await expect(viewer.load('/models/fox.glb')).rejects.toThrow('GPU 장치를 잃었어요');
      expect(made.renderers).toHaveLength(3);
      expect(download).toHaveBeenCalledOnce();
    });
  });

  it('타일 미리보기는 투명한 캔버스에 그리고, 장치를 잃으면 다시 만들다 거듭 잃으면 오류를 보인다', async () => {
    const tile = { id: 'tile', surface: 'grass', size: 512, seed: 1, gpu: { estimated_bytes_with_mips: 0 },
      artifacts: ['albedo.webp', 'normal.webp', 'orm.webp'].map(name => ({ name, url: `/tiles/${name}` })) };
    const { container, unmount } = await mount(<TilePreview tile={tile} />);
    await flush();
    const label = () => container.querySelector('.tile-renderer-label')?.textContent;
    expect(made.renderers).toHaveLength(1);
    expect(made.renderers[0]!.options.alpha).toBe(true);
    expect(made.renderers[0]!.setClearColor).toHaveBeenCalledWith(0x000000, 0);
    expect(label()).toBe('WebGPU');

    for (let loss = 1; loss <= TILE_DEVICE_RECOVERIES; loss++) {
      await lose(made.renderers[loss - 1]!);
      await flush();
      expect(made.renderers).toHaveLength(loss + 1);
      expect(label()).toBe('WebGPU');
    }
    await lose(made.renderers.at(-1)!);
    await flush();
    expect(made.renderers).toHaveLength(TILE_DEVICE_RECOVERIES + 1);
    expect(label()).toBe('렌더러 오류');
    await unmount();
  });
});
