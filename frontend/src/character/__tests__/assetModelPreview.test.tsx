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

/** Scrolls the card into or out of view: the last one mounted, or each by its place in `cards`. */
let shown!: (visible: boolean) => void;
const cards: ((visible: boolean) => void)[] = [];
const settle = () => act(async () => { for (let round = 0; round < 5; round++) await Promise.resolve(); });

describe('갤러리 카드의 3D 미리보기', () => {
  beforeEach(() => {
    viewers.length = 0;
    cards.length = 0;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        shown = (visible) => callback([{ isIntersecting: visible }]);
        cards.push(shown);
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

  it('화면 밖으로 나간 카드는 최근 넷만 뷰어를 남기고, 오래 나가 있으면 그것도 놓는다', async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = await mount(<>{[1, 2, 3, 4, 5, 6].map((item) =>
        <AssetModelPreview key={item} model={{ url: `/models/${item}.glb`, label: '표준 골격' }} name={`동물 ${item}`} emptyLabel="" autoLoad />)}</>);
      for (const card of cards) await act(async () => card(true));
      await settle();
      expect(viewers).toHaveLength(6);
      for (const card of cards) await act(async () => card(false));
      // The two hidden first gave way to the four hidden after them.
      expect(viewers.map((viewer) => viewer.dispose.mock.calls.length)).toEqual([1, 1, 0, 0, 0, 0]);

      await act(async () => cards[2]!(true));
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(viewers.map((viewer) => viewer.dispose.mock.calls.length)).toEqual([1, 1, 0, 1, 1, 1]);

      // A card that comes back after giving its viewer away builds a new one.
      await act(async () => cards[0]!(true));
      await settle();
      expect(viewers).toHaveLength(7);
      await unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('화면에 카드가 많으면 화면 밖 카드는 뷰어를 남기지 않는다', async () => {
    const { unmount } = await mount(<>{Array.from({ length: 14 }, (_, item) =>
      <AssetModelPreview key={item} model={{ url: `/models/${item}.glb`, label: '표준 골격' }} name={`동물 ${item}`} emptyLabel="" autoLoad />)}</>);
    for (const card of cards) await act(async () => card(true));
    await settle();
    expect(viewers).toHaveLength(14);
    await act(async () => cards[0]!(false));
    await act(async () => cards[1]!(false));
    // Twelve still on screen use up what all cards may hold.
    expect(viewers.map((viewer) => viewer.dispose.mock.calls.length).slice(0, 3)).toEqual([1, 1, 0]);
    await unmount();
  });
});

