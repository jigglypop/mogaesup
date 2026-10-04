import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { AssetModelPreview } from '../studio/AssetModelPreview';

// The WebGPU viewer is not what is tested: it only loads a model with an idle and a walk clip and says what it was told.
const viewers = vi.hoisted(() => [] as { play: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[]);
vi.mock('../viewer', () => ({
  ModelViewer: class {
    load = vi.fn(async () => [{ index: 0, name: 'idle' }, { index: 1, name: 'walk' }]);
    play = vi.fn();
    dispose = vi.fn();
    setCardView = vi.fn();
    setWireframe = vi.fn();
    constructor() {
      viewers.push(this);
    }
  },
}));
vi.mock('../studio/AssetModelStats', () => ({ AssetModelStats: () => null }));

/** Scrolls the card into or out of view. */
let shown!: (visible: boolean) => void;
const settle = () => act(async () => { for (let round = 0; round < 5; round++) await Promise.resolve(); });

describe('갤러리 카드의 3D 미리보기', () => {
  beforeEach(() => {
    viewers.length = 0;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        shown = (visible) => callback([{ isIntersecting: visible }]);
      }
      observe() {}
      disconnect() {}
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('가리키거나 초점이 있을 때만 걷고, 화면 밖으로 나갔다 와도 뷰어를 다시 만들지 않는다', async () => {
    const { container, unmount } = await mount(
      <AssetModelPreview model={{ url: '/models/dog.glb', label: '표준 골격' }} name="강아지" emptyLabel="" autoLoad animate clip="walk" />,
    );
    expect(viewers).toHaveLength(0);
    await act(async () => shown(true));
    await settle();
    const viewer = viewers[0]!;
    expect(viewer.play).toHaveBeenLastCalledWith(-1);

    const card = container.querySelector('.asset-model-preview')!;
    await act(async () => { card.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); });
    expect(viewer.play).toHaveBeenLastCalledWith(1);
    await act(async () => { card.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })); });
    expect(viewer.play).toHaveBeenLastCalledWith(-1);
    await act(async () => container.querySelector<HTMLButtonElement>('.asset-model-preview-toggle')!.focus());
    expect(viewer.play).toHaveBeenLastCalledWith(1);
    await act(async () => container.querySelector<HTMLButtonElement>('.asset-model-preview-toggle')!.blur());
    expect(viewer.play).toHaveBeenLastCalledWith(-1);

    await act(async () => shown(false));
    await act(async () => shown(true));
    await settle();
    expect(viewers).toHaveLength(1);
    expect(viewer.dispose).not.toHaveBeenCalled();
    await unmount();
    expect(viewer.dispose).toHaveBeenCalledTimes(1);
  });
});
