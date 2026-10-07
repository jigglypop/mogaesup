import { act, useState } from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { IslandChangeError } from '../edit/islandChange';
import { IslandChooser, useIslandChooser, type IslandChooserProps } from '../edit/IslandChooser';
import type { SaverState } from '../edit/save';

const props = (overrides: Partial<IslandChooserProps> = {}): IslandChooserProps => ({
  mode: 'first',
  current: 'forest',
  onChange: vi.fn(async () => true),
  onRestore: vi.fn(async () => true),
  loadPrevious: vi.fn(async () => null),
  onKeep: vi.fn(async () => true),
  onClose: vi.fn(),
  ...overrides,
});
const dialog = () => document.querySelector<HTMLElement>('[role=dialog]');
const button = (name: string) => [...(dialog()?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.trim().startsWith(name));

afterEach(() => vi.restoreAllMocks());

describe('섬 고르기 창', () => {
  it('처음에는 카드를 누르면 묻지 않고 그 섬으로 바꾼 뒤 닫힌다', async () => {
    const chosen = props();
    const { unmount } = await mount(<IslandChooser {...chosen} />);
    expect(dialog()?.querySelector('h2')?.textContent).toBe('섬 고르기');
    expect(dialog()?.querySelectorAll('.mg-island-card')).toHaveLength(8);
    expect(chosen.loadPrevious).not.toHaveBeenCalled();
    await act(async () => button('도시')!.click());
    expect(chosen.onChange).toHaveBeenCalledWith('city');
    expect(chosen.onClose).toHaveBeenCalledTimes(1);
    expect(dialog()?.textContent).not.toContain('바꿀까요');
    await unmount();
  });

  it('처음 창을 닫으면 지금 섬(숲)을 저장한다', async () => {
    const chosen = props();
    const { unmount } = await mount(<IslandChooser {...chosen} />);
    await act(async () => button('닫기')!.click());
    expect(chosen.onKeep).toHaveBeenCalledTimes(1);
    expect(chosen.onChange).not.toHaveBeenCalled();
    expect(chosen.onClose).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('바꿀 때는 지금 섬을 표시하고, 고르면 설명 없이 한 번 묻는다', async () => {
    const chosen = props({ mode: 'change', current: 'cafe' });
    const { unmount } = await mount(<IslandChooser {...chosen} />);
    expect(dialog()?.querySelector('h2')?.textContent).toBe('섬 바꾸기');
    expect(button('카페')?.textContent).toContain('지금');
    expect(button('숲')?.textContent).not.toContain('지금');
    await act(async () => button('겨울')!.click());
    expect(chosen.onChange).not.toHaveBeenCalled();
    expect(dialog()?.querySelector('.mg-island-confirm span')?.textContent).toBe('겨울로 바꿀까요?');
    await act(async () => button('취소')!.click());
    expect(dialog()?.querySelector('.mg-island-confirm')).toBeNull();
    await act(async () => button('공원')!.click());
    expect(dialog()?.querySelector('.mg-island-confirm span')?.textContent).toBe('공원으로 바꿀까요?');
    await act(async () => button('바꾸기')!.click());
    expect(chosen.onChange).toHaveBeenCalledWith('park');
    expect(chosen.onClose).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('보관한 이전 섬이 있으면 그 카드로 되돌린다', async () => {
    const chosen = props({
      mode: 'change',
      loadPrevious: vi.fn(async () => ({ blob: { version: 1, savedAt: 1, domains: { island: { version: 1, template: 'beach' } } }, updatedAt: '2026-10-07T06:05:00Z' })),
    });
    const { unmount } = await mount(<IslandChooser {...chosen} />);
    const previous = button('이전 섬')!;
    expect(previous.querySelector('img')?.getAttribute('src')).toBe('/islands/beach.webp');
    expect(previous.querySelector('small')?.textContent).toMatch(/^10월 7일 오[전후] \d{1,2}:05$/);
    await act(async () => previous.click());
    expect(dialog()?.querySelector('.mg-island-confirm span')?.textContent).toBe('이전 섬으로 바꿀까요?');
    await act(async () => button('바꾸기')!.click());
    expect(chosen.onRestore).toHaveBeenCalledTimes(1);
    expect(chosen.onChange).not.toHaveBeenCalled();
    await unmount();
  });

  it('바꾸지 못하면 이유를 보이고 창은 그대로 둔다', async () => {
    const chosen = props({ mode: 'change', onChange: vi.fn(async () => Promise.reject(new IslandChangeError('지금 섬을 저장하지 못해 바꾸지 않았어요.'))) });
    const { unmount } = await mount(<IslandChooser {...chosen} />);
    await act(async () => button('농장')!.click());
    await act(async () => button('바꾸기')!.click());
    expect(dialog()?.querySelector('[role=alert]')?.textContent).toBe('지금 섬을 저장하지 못해 바꾸지 않았어요.');
    expect(chosen.onClose).not.toHaveBeenCalled();
    await unmount();
  });
});

/** The chooser's state on a page: shown as `data-mode`, with a button that opens it to change. */
function Page({ isOwner, phase, revision }: { isOwner: boolean; phase: SaverState['phase']; revision: number }) {
  const [stored] = useState(() => ({ revision }));
  stored.revision = revision;
  const chooser = useIslandChooser(isOwner, phase, stored);
  return (
    <div data-mode={chooser.mode ?? 'none'}>
      <button onClick={chooser.change}>섬 바꾸기</button>
      <button onClick={chooser.close}>닫기</button>
    </div>
  );
}

describe('섬 고르기가 열리는 때', () => {
  const modeOf = (container: HTMLElement) => container.querySelector('[data-mode]')?.getAttribute('data-mode');

  it('저장한 적 없는 주인의 섬이 다 불러와지면 한 번 연다', async () => {
    const { container, rerender, unmount } = await mount(<Page isOwner phase="loading" revision={0} />);
    expect(modeOf(container)).toBe('none');
    await rerender(<Page isOwner phase="ready" revision={0} />);
    expect(modeOf(container)).toBe('first');
    await act(async () => [...container.querySelectorAll('button')].find((item) => item.textContent === '닫기')!.click());
    // Loading again (a conflict's reload) does not ask a second time.
    await rerender(<Page isOwner phase="loading" revision={0} />);
    await rerender(<Page isOwner phase="ready" revision={0} />);
    expect(modeOf(container)).toBe('none');
    await unmount();
  });

  it('방문자나 이미 저장된 섬에는 열지 않고, 서랍의 섬 바꾸기로만 연다', async () => {
    const visitor = await mount(<Page isOwner={false} phase="ready" revision={0} />);
    expect(modeOf(visitor.container)).toBe('none');
    await visitor.unmount();
    const saved = await mount(<Page isOwner phase="ready" revision={3} />);
    expect(modeOf(saved.container)).toBe('none');
    await act(async () => [...saved.container.querySelectorAll('button')].find((item) => item.textContent === '섬 바꾸기')!.click());
    expect(modeOf(saved.container)).toBe('change');
    await saved.unmount();
  });
});
