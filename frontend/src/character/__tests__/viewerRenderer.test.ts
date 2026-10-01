import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { init } = vi.hoisted(() => ({ init: vi.fn<() => Promise<void>>() }));
vi.mock('three/webgpu', () => ({
  WebGPURenderer: class {
    init = init;
    dispose() {}
  },
}));

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
    vi.unstubAllGlobals();
    init.mockReset();
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
});
