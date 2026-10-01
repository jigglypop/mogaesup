import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HomeView } from '../../api/types';
import { mount, type } from '../../__tests__/mount';
import { About, wantsSave } from '../Profile';

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
    beforeEach(() => vi.useFakeTimers());
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
  });
});
