import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HomeView } from '../../api/types';
import { draftKey } from '../../auth/drafts';
import { mount, type } from '../../__tests__/mount';
import { About, openingText, wantsSave } from '../Profile';

const view = (changes: Partial<HomeView['profile']> = {}): HomeView => ({
  isOwner: true,
  visits: { today: 0, total: 0 },
  profile: {
    ownerId: 'owner',
    username: 'mogae',
    ownerName: '모개',
    title: '모개숲',
    statusMessage: '오늘도 맑음',
    mood: 0,
    minime: 'man',
    emoji: '😊',
    visibility: 'public',
    updatedAt: '2026-09-30T00:00:00Z',
    ...changes,
  },
});

describe('상태 메시지 저장', () => {
  it('끝의 빈칸만 다른 글은 저장하지 않고, 지운 칸은 허용된 곳에서만 저장한다', () => {
    expect(wantsSave('오늘도 맑음 ', '오늘도 맑음', false)).toBe(false);
    expect(wantsSave('내일은 비', '오늘도 맑음', false)).toBe(true);
    expect(wantsSave('', '오늘도 맑음', false)).toBe(false);
    expect(wantsSave('   ', '오늘도 맑음', false)).toBe(false);
    expect(wantsSave('', '오늘도 맑음', true)).toBe(true);
    expect(wantsSave('   ', '', true)).toBe(false);
  });

  describe('화면에서', () => {
    const onUpdate = vi.fn();
    beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
    afterEach(() => {
      vi.useRealTimers();
      onUpdate.mockReset();
    });

    const open = () => mount(<About view={view()} minimes={[]} look={null} onUpdate={onUpdate} onWearLook={() => {}} />);
    const wait = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    it('상태 메시지를 모두 지우면 잠시 뒤 빈 메시지로 저장한다', async () => {
      const { container, unmount } = await open();
      await type(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="상태 메시지"]')!, '');
      await wait(900);
      expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ statusMessage: '' });
      await unmount();
    });

    it('섬 이름은 지워도 저장하지 않는다', async () => {
      const { container, unmount } = await open();
      await type(container.querySelector<HTMLInputElement>('input[aria-label="섬 이름"]')!, '   ');
      await wait(900);
      expect(onUpdate).not.toHaveBeenCalled();
      await unmount();
    });

    it('800ms 전에 소개 탭을 닫아도 마지막 입력을 저장한다', async () => {
      const { container, unmount } = await open();
      await type(container.querySelector<HTMLTextAreaElement>('textarea')!, '내일은 비');
      await unmount();
      expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ statusMessage: '내일은 비' });
    });

    it('저장 실패를 표시하고 다시 열어도 실패한 입력을 남긴다', async () => {
      onUpdate.mockRejectedValue(new TypeError('offline'));
      const first = await open();
      await type(first.container.querySelector<HTMLTextAreaElement>('textarea')!, '내일은 비'); await wait(900);
      expect(first.container.querySelector('[role=alert]')?.textContent).toContain('잠시 후 다시 시도');
      await first.unmount();
      const next = await open(); expect(next.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('내일은 비');
      await next.unmount();
    });

    it('앞 저장 응답이 와도 그 뒤에 타이핑한 입력을 되돌리지 않는다', async () => {
      let finish!: () => void;
      onUpdate.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
      const { container, rerender, unmount } = await open();
      await type(container.querySelector<HTMLTextAreaElement>('textarea')!, '내일은 비'); await wait(900);
      await type(container.querySelector<HTMLTextAreaElement>('textarea')!, '모레는 맑음');
      await rerender(<About view={view({ statusMessage: '내일은 비' })} minimes={[]} look={null} onUpdate={onUpdate} onWearLook={() => {}} />);
      finish(); await wait(0);
      expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('모레는 맑음');
      expect(onUpdate).toHaveBeenLastCalledWith({ statusMessage: '모레는 맑음' });
      await unmount();
    });

    it('저장이 진행 중일 때 원래 글로 되돌리고 닫으면 되돌린 글도 저장한다', async () => {
      let finish!: () => void;
      onUpdate.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
      const { container, unmount } = await open();
      await type(container.querySelector<HTMLTextAreaElement>('textarea')!, '내일은 비'); await wait(900);
      await type(container.querySelector<HTMLTextAreaElement>('textarea')!, '오늘도 맑음');
      expect(JSON.parse(localStorage.getItem(draftKey('owner', 'status'))!)).toEqual({ text: '오늘도 맑음', base: '오늘도 맑음' });
      await unmount(); finish(); await wait(0);
      expect(onUpdate).toHaveBeenNthCalledWith(2, { statusMessage: '오늘도 맑음' });
    });

    it('저장한 값이 돌아와도 이어 치던 끝의 빈칸을 지우지 않는다', async () => {
      let finish!: () => void;
      onUpdate.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
      const { container, rerender, unmount } = await open();
      const field = () => container.querySelector<HTMLTextAreaElement>('textarea')!;
      await type(field(), '내일은 비');
      await wait(900);
      expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ statusMessage: '내일은 비' });
      // The next word is on its way: a space typed while the save answers.
      await type(field(), '내일은 비 ');
      finish();
      await wait(0);
      await rerender(<About view={view({ statusMessage: '내일은 비' })} minimes={[]} look={null} onUpdate={onUpdate} onWearLook={() => {}} />);
      await wait(0);
      expect(field().value).toBe('내일은 비 ');
      await wait(900);
      expect(onUpdate).toHaveBeenCalledTimes(1);
      await unmount();
    });

    it('남겨 둔 초안은 그 초안을 쓸 때의 서버 값이 그대로일 때만 되살리고, 서버 값이 바뀌었으면 버린다', async () => {
      localStorage.setItem(draftKey('owner', 'status'), JSON.stringify({ text: '쓰다 만 글', base: '오늘도 맑음' }));
      const kept = await open();
      expect(kept.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('쓰다 만 글');
      await kept.unmount();
      onUpdate.mockReset();

      // Meanwhile another device saved a newer message.
      localStorage.setItem(draftKey('owner', 'status'), JSON.stringify({ text: '쓰다 만 글', base: '오늘도 맑음' }));
      const newer = await mount(<About view={view({ statusMessage: '다른 기기에서 쓴 글' })} minimes={[]} look={null} onUpdate={onUpdate} onWearLook={() => {}} />);
      expect(newer.container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('다른 기기에서 쓴 글');
      expect(localStorage.getItem(draftKey('owner', 'status'))).toBeNull();
      await newer.unmount();
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it('예전 형식(글만 있는) 초안은 무엇을 바탕으로 썼는지 몰라 되살리지 않는다', () => {
      localStorage.setItem(draftKey('owner', 'title'), '"옛 초안"');
      expect(openingText(draftKey('owner', 'title'), '모개숲')).toBe('모개숲');
      localStorage.setItem(draftKey('owner', 'title'), '옛 초안');
      expect(openingText(draftKey('owner', 'title'), '모개숲')).toBe('모개숲');
    });
  });
});
