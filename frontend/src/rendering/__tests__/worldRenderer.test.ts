import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorldRenderer } from '../worldRenderer';

// No GPU here: WebGPU is unavailable, and the node renderer on WebGL2 is a stand-in that records what is done to it.
const engine = vi.hoisted(() => ({ renderers: [] as { onDeviceLost: (info: unknown) => void; disposed: number }[] }));
vi.mock('gaesup-world', () => ({
  RENDERER_LOST_EVENT: 'gaesup:renderer-lost',
  isWebGPUAvailable: async () => false,
  createRenderer: vi.fn(),
  createLegacyRenderer: vi.fn(),
}));
vi.mock('three/webgpu', () => ({
  WebGPURenderer: class {
    onDeviceLost = (_info: unknown) => {};
    disposed = 0;
    constructor() {
      engine.renderers.push(this);
    }
    async init() {}
    dispose() {
      this.disposed++;
    }
  },
}));

describe('WebGL2로 그리는 섬의 렌더러', () => {
  afterEach(() => {
    engine.renderers.length = 0;
    vi.restoreAllMocks();
  });

  it('컨텍스트를 잃으면 엔진의 렌더러처럼 알려 캔버스가 다시 붙는다', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lost = vi.fn();
    window.addEventListener('gaesup:renderer-lost', lost);
    const renderer = (await createWorldRenderer({ canvas: document.createElement('canvas') })) as unknown as {
      forceContextLoss: () => void;
    };
    const made = engine.renderers[0]!;
    made.onDeviceLost({ api: 'WebGL', message: 'context lost' });
    expect(lost).toHaveBeenCalledTimes(1);
    expect((lost.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({ api: 'WebGL' });

    // R3F letting the canvas go loses the context on purpose: once, and without another announcement.
    renderer.forceContextLoss();
    renderer.forceContextLoss();
    made.onDeviceLost({ api: 'WebGL', message: 'disposed' });
    expect(made.disposed).toBe(1);
    expect(lost).toHaveBeenCalledTimes(1);
    window.removeEventListener('gaesup:renderer-lost', lost);
  });
});
