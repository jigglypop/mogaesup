import { act } from 'react';

import { describe, expect, it, vi } from 'vitest';

import type { HomeProfile } from '../../api/types';
import { mount } from '../../__tests__/mount';
import { ProfileCard } from '../ui/ProfileCard';

const profile: HomeProfile = {
  ownerId: 'u1',
  username: 'sol',
  ownerName: '솔',
  title: '솔의 섬',
  statusMessage: '',
  mood: 0,
  minime: 'man',
  emoji: '😊',
  visibility: 'private',
  updatedAt: '2026-11-01T00:00:00Z',
  balloon: 'glass',
  sajuShareConsent: false,
};

describe('프로필', () => {
  it('이름과 섬 이름, 상태 메시지를 저장한다', async () => {
    const onSave = vi.fn(async () => undefined);
    const { container, unmount } = await mount(<ProfileCard profile={profile} onSave={onSave} />);
    const field = (label: string) => container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
    const set = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => set(field('이름'), '가온'));
    await act(async () => set(field('섬 이름'), '가온의 섬'));
    await act(async () => set(field('상태 메시지'), '집에 있어요'));
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '저장')!.click());
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ displayName: '가온', title: '가온의 섬', statusMessage: '집에 있어요' });
    await unmount();
  });
});
