import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { AssetModelPreview } from '../studio/AssetModelPreview';
import { HIDDEN_MS, KEEP_HIDDEN, liveViewers, MAX_LIVE } from '../studio/live-viewers';

// The WebGPU viewer is not what is tested: it only loads a model with an idle and a walk clip (or fails to, for a URL in
// `failing`), says what it was told and hands back a still picture of itself once `hold` settles. Like a real one it
// draws no frame for the picture while the page is hidden.
const viewers = vi.hoisted(() => [] as { load: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; snapshot: ReturnType<typeof vi.fn> }[]);
const control = vi.hoisted(() => ({ failing: new Set<string>(), hold: null as Promise<void> | null }));
vi.mock('../viewer', () => ({
  ModelViewer: class {
    load = vi.fn(async (url: string) => {
      if (control.failing.has(url)) throw new Error('모델 파일을 불러올 수 없어요.');
      return [{ index: 0, name: 'idle' }, { index: 1, name: 'walk' }];
    });
    play = vi.fn();
    dispose = vi.fn();
    setCardView = vi.fn();
    setWireframe = vi.fn();
    snapshot = vi.fn(async (): Promise<{ src: string; renderer: string }> => {
      if (document.hidden) await new Promise(() => {});
      if (control.hold) await control.hold;
      return { src: `data:image/webp;base64,still-${viewers.indexOf(this as never)}`, renderer: 'webgpu' };
    });
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
const disposed = () => viewers.map((viewer) => viewer.dispose.mock.calls.length);
const gallery = (count: number) => <>{Array.from({ length: count }, (_, item) =>
  <AssetModelPreview key={item} model={{ url: `/models/${item}.glb`, label: '표준 골격' }} name={`동물 ${item}`} emptyLabel="" autoLoad />)}</>;

describe('갤러리 카드의 3D 미리보기', () => {
  beforeEach(() => {
    viewers.length = 0;
    cards.length = 0;
    control.failing.clear();
    control.hold = null;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        shown = (visible) => callback([{ isIntersecting: visible }]);
        cards.push(shown);
      }
      observe() {}
      disconnect() {}
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, 'hidden');
    expect(liveViewers()).toBe(0);
  });

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

  it(`화면 밖으로 나간 카드는 최근 ${KEEP_HIDDEN}개만 뷰어를 남기고, 오래 나가 있으면 그것도 놓는다`, async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = await mount(gallery(6));
      for (const card of cards) await act(async () => card(true));
      await settle();
      expect(viewers).toHaveLength(6);
      for (const card of cards) await act(async () => card(false));
      await settle();
      // The three hidden first gave way to the three hidden after them.
      expect(disposed()).toEqual([1, 1, 1, 0, 0, 0]);

      await act(async () => cards[3]!(true));
      await act(async () => { await vi.advanceTimersByTimeAsync(HIDDEN_MS); });
      await settle();
      expect(disposed()).toEqual([1, 1, 1, 0, 1, 1]);

      // A card that comes back after giving its viewer away builds a new one.
      await act(async () => cards[0]!(true));
      await settle();
      expect(viewers).toHaveLength(7);
      await unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it(`화면에 카드가 많아도 뷰어는 ${MAX_LIVE}개까지만 두고, 가리킨 카드가 가장 오래 안 쓴 카드의 뷰어를 받는다`, async () => {
    const count = MAX_LIVE + 6;
    const { container, unmount } = await mount(gallery(count));
    for (const card of cards) await act(async () => card(true));
    await settle();
    expect(viewers).toHaveLength(MAX_LIVE);
    expect(liveViewers()).toBe(MAX_LIVE);
    const previews = [...container.querySelectorAll('.asset-model-preview')];
    // The cards left waiting show a placeholder, not an empty canvas.
    expect(previews[count - 1]!.querySelector('.asset-model-preview-empty')?.textContent).toBe('3D 미리보기 준비 중');

    // Pointing at a waiting card hands it the viewer of the card used longest ago, which keeps a picture of its model.
    await act(async () => { previews[count - 1]!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); });
    await settle();
    expect(liveViewers()).toBe(MAX_LIVE);
    expect(viewers).toHaveLength(MAX_LIVE + 1);
    expect(disposed().slice(0, 2)).toEqual([1, 0]);
    expect(previews[0]!.querySelector('img')?.getAttribute('src')).toBe('data:image/webp;base64,still-0');
    expect(previews[0]!.querySelector('img')?.getAttribute('alt')).toBe('동물 0 3D 모델');

    // Pointing at another card takes the next oldest, never the one just pointed at.
    await act(async () => { previews[count - 2]!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); });
    await settle();
    expect(disposed()).toEqual([1, 1, ...Array(MAX_LIVE).fill(0)]);
    await unmount();
  });

  it('뷰어를 다 쓴 뒤에도 눌러서 3D를 연 카드는 뷰어를 받는다', async () => {
    const { container, unmount } = await mount(<>{gallery(MAX_LIVE)}
      <AssetModelPreview model={{ url: '/models/closed.glb', label: '저장본' }} name="닫힌 카드" emptyLabel="" /></>);
    for (const card of cards) await act(async () => card(true));
    await settle();
    expect(viewers).toHaveLength(MAX_LIVE);
    const toggle = [...container.querySelectorAll<HTMLButtonElement>('.asset-model-preview-toggle')].at(-1)!;
    expect(toggle.textContent).toBe('3D 보기');
    await act(async () => { toggle.focus(); toggle.click(); });
    await settle();
    expect(viewers).toHaveLength(MAX_LIVE + 1);
    expect(liveViewers()).toBe(MAX_LIVE);
    expect(disposed()[0]).toBe(1);
    await unmount();
  });

  it('상세 보기는 카드가 뷰어를 다 써도 하나를 받는다', async () => {
    const { unmount } = await mount(gallery(MAX_LIVE));
    for (const card of cards) await act(async () => card(true));
    await settle();
    expect(liveViewers()).toBe(MAX_LIVE);
    const detail = await mount(<AssetModelPreview model={{ url: '/models/detail.glb', label: '저장본' }} name="상세" emptyLabel="" detail />);
    await act(async () => shown(true));
    await settle();
    expect(viewers).toHaveLength(MAX_LIVE + 1);
    expect(viewers.at(-1)!.dispose).not.toHaveBeenCalled();
    expect(disposed().filter((count) => count > 0)).toHaveLength(1);
    await detail.unmount();
    await unmount();
  });

  it('3D를 불러오지 못한 카드는 뷰어 자리를 내주고, 다시 시도하면 다시 받는다', async () => {
    control.failing.add('/models/0.glb');
    const count = MAX_LIVE + 1;
    const { container, unmount } = await mount(gallery(count));
    for (const card of cards) await act(async () => card(true));
    await settle();
    const previews = [...container.querySelectorAll('.asset-model-preview')];
    expect(previews[0]!.querySelector('[role=alert]')?.textContent).toContain('3D 미리보기 로드 실패');
    // The place the failed card gave back went to the card that was waiting for one.
    expect(viewers).toHaveLength(MAX_LIVE + 1);
    expect(viewers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(liveViewers()).toBe(MAX_LIVE);
    expect(previews[count - 1]!.querySelector('.asset-model-preview-empty')).toBeNull();

    control.failing.clear();
    const retry = previews[0]!.querySelector<HTMLButtonElement>('.asset-model-preview-error button')!;
    expect(retry.textContent).toBe('다시 시도');
    await act(async () => { retry.focus(); retry.click(); });
    await settle();
    expect(viewers).toHaveLength(MAX_LIVE + 2);
    expect(viewers.at(-1)!.load).toHaveBeenCalledWith('/models/0.glb', { sha256: undefined });
    expect(previews[0]!.querySelector('[role=alert]')).toBeNull();
    expect(liveViewers()).toBe(MAX_LIVE);
    expect(viewers.filter((viewer) => !viewer.dispose.mock.calls.length)).toHaveLength(MAX_LIVE);
    await unmount();
  });

  it('뷰어를 내주며 그림을 찍는 사이 다시 가리킨 카드는 그 뷰어를 계속 쓴다', async () => {
    const count = MAX_LIVE + 1;
    const { container, unmount } = await mount(gallery(count));
    for (const card of cards) await act(async () => card(true));
    await settle();
    const previews = [...container.querySelectorAll('.asset-model-preview')];
    let picture!: () => void;
    control.hold = new Promise<void>((done) => (picture = done));
    // The waiting card takes card 0's viewer, which starts taking its picture...
    await act(async () => { previews[count - 1]!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); });
    await settle();
    expect(viewers[0]!.snapshot).toHaveBeenCalledOnce();
    // ...and card 0 is pointed at before the picture is taken: it is granted a viewer again, from the card used longest ago.
    await act(async () => { previews[0]!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); });
    await settle();
    control.hold = null;
    await act(async () => picture());
    await settle();
    expect(viewers[0]!.dispose).not.toHaveBeenCalled();
    expect(previews[0]!.querySelector('.asset-model-preview-canvas')).not.toBeNull();
    expect(liveViewers()).toBe(MAX_LIVE);
    expect(viewers.filter((viewer) => !viewer.dispose.mock.calls.length)).toHaveLength(MAX_LIVE);
    await unmount();
  });

  it('가려진 탭에서는 그림을 기다리지 않고, 그림이 제때 오지 않아도 뷰어를 놓는다', async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = await mount(gallery(2));
      for (const card of cards) await act(async () => card(true));
      await settle();
      expect(viewers).toHaveLength(2);
      // A hidden tab draws no frame: card 0 gives its viewer up without one.
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      await act(async () => cards[0]!(false));
      await act(async () => { await vi.advanceTimersByTimeAsync(HIDDEN_MS); });
      await settle();
      expect(viewers[0]!.snapshot).not.toHaveBeenCalled();
      expect(viewers[0]!.dispose).toHaveBeenCalledTimes(1);

      // Shown again, a picture that never comes is waited for a moment only.
      Reflect.deleteProperty(document, 'hidden');
      control.hold = new Promise(() => {});
      await act(async () => cards[1]!(false));
      await act(async () => { await vi.advanceTimersByTimeAsync(HIDDEN_MS); });
      await settle();
      expect(viewers[1]!.snapshot).toHaveBeenCalledOnce();
      expect(viewers[1]!.dispose).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      await settle();
      expect(viewers[1]!.dispose).toHaveBeenCalledTimes(1);
      expect(liveViewers()).toBe(0);
      await unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
