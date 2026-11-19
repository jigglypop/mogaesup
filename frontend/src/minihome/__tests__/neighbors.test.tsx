import { act } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../api/client';
import type { HomeView, IlchonRequest, IlchonStatus, User } from '../../api/types';
import { mount } from '../../__tests__/mount';

const social = vi.hoisted(() => ({
  ilchons: vi.fn(),
  requests: vi.fn(),
  status: vi.fn(),
  accept: vi.fn(),
  dismiss: vi.fn(),
  request: vi.fn(),
  unlink: vi.fn(),
}));
vi.mock('../../api/endpoints', () => ({ socialApi: social }));
vi.mock('../../shell/Shell', () => ({ initialOf: (name: string) => name[0], toneOf: () => '0', REQUESTS_CHANGED: 'mogaesup:requests' }));

import { NeighborsTab, useNeighbors } from '../Ilchons';

const card = (username: string) => ({ id: `id-${username}`, username, displayName: username, emoji: '😊' });
const view = (isOwner: boolean): HomeView => ({
  isOwner,
  visits: { today: 1, total: 1 },
  profile: {
    ownerId: 'owner', username: 'host', ownerName: '주인', title: '섬', statusMessage: '', mood: 0, minime: 'man', emoji: '😊',
    visibility: 'public', updatedAt: '2026-10-01T00:00:00Z',
  },
});
/** Someone else's 섬, for a visitor. */
const friendView = (): HomeView => ({ ...view(false), profile: { ...view(false).profile, ownerId: 'friend', username: 'friend', ownerName: '친구' } });
const visitorA: User = { id: 'a', username: 'a', displayName: 'A', role: 'user' };
const visitorB: User = { id: 'b', username: 'b', displayName: 'B', role: 'user' };
const none: IlchonStatus = { relation: 'none', ilchon: null, request: null };
const request = (id: string): IlchonRequest => ({ id, from: card('guest'), to: card('host'), name: '이웃', theirName: '이웃', message: '', createdAt: '' });

function Tab({ home, viewer }: { home: HomeView; viewer: User | null }) {
  const neighbors = useNeighbors(home, viewer);
  return <NeighborsTab view={home} viewer={viewer} neighbors={neighbors} />;
}
const screen = (home: HomeView, viewer: User | null) => (
  <MemoryRouter>
    <Tab home={home} viewer={viewer} />
  </MemoryRouter>
);
const settle = () => act(async () => { for (let round = 0; round < 3; round++) await Promise.resolve(); });
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);

beforeEach(() => {
  social.ilchons.mockResolvedValue({ ilchons: [] });
  social.requests.mockResolvedValue({ received: [], sent: [] });
  social.status.mockResolvedValue(none);
});
afterEach(() => {
  for (const mock of Object.values(social)) mock.mockReset();
});

describe('이웃 목록', () => {
  it('늦게 온 이전 읽기의 답은 나중 읽기의 답을 덮지 않는다', async () => {
    let first!: (value: unknown) => void;
    social.ilchons.mockImplementationOnce(() => new Promise((resolve) => { first = resolve; }))
      .mockResolvedValueOnce({ ilchons: [{ user: card('new'), name: '이웃', theirName: '이웃', since: '' }] });
    const { container, unmount } = await mount(screen(view(false), null));
    await act(async () => { window.dispatchEvent(new Event('mogaesup:requests')); });
    await settle();
    expect(container.textContent).toContain('new');
    await act(async () => first({ ilchons: [{ user: card('old'), name: '이웃', theirName: '이웃', since: '' }] }));
    expect(container.textContent).toContain('new');
    expect(container.textContent).not.toContain('old');
    await unmount();
  });

  it('읽기에 실패해 보인 문제는 다음 읽기가 되면 지운다', async () => {
    social.ilchons.mockRejectedValueOnce(new ApiRequestError(503, 'database', '잠시 후 다시 시도해 주세요.'));
    const { container, unmount } = await mount(screen(view(false), null));
    await settle();
    expect(container.querySelector('[role=alert]')?.textContent).toBe('잠시 후 다시 시도해 주세요.');
    await act(async () => { window.dispatchEvent(new Event('mogaesup:requests')); });
    await settle();
    expect(container.querySelector('[role=alert]')).toBeNull();
    await unmount();
  });

  it('하나를 처리하는 동안 다른 버튼은 기다리고, 두 번 눌러도 한 번만 보낸다', async () => {
    social.requests.mockResolvedValue({ received: [request('r1'), request('r2')], sent: [] });
    let done!: () => void;
    social.accept.mockImplementationOnce(() => new Promise<void>((resolve) => { done = resolve; }));
    const { container, unmount } = await mount(screen(view(true), { ...visitorA, id: 'owner', username: 'host' }));
    await settle();
    const accepts = [...container.querySelectorAll('button')].filter((item) => item.textContent?.trim() === '수락');
    expect(accepts).toHaveLength(2);
    await act(async () => { accepts[0]!.click(); accepts[0]!.click(); accepts[1]!.click(); });
    expect(social.accept).toHaveBeenCalledExactlyOnceWith('r1', {});
    expect(accepts[1]!.getAttribute('aria-disabled')).toBe('true');
    await act(async () => done());
    await settle();
    expect(button(container, '수락')?.hasAttribute('aria-disabled')).toBe(false);
    await unmount();
  });

  it('다른 방문자로 바뀌면 그 사람의 사이를 다시 읽는다', async () => {
    social.status.mockResolvedValueOnce({ relation: 'requested', ilchon: null, request: request('mine') }).mockResolvedValueOnce(none);
    const { container, rerender, unmount } = await mount(screen(view(false), visitorA));
    await settle();
    expect(container.textContent).toContain('이웃 신청을 보냈어요');
    await rerender(screen(view(false), visitorB));
    await settle();
    expect(social.status).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('이웃 신청을 보냈어요');
    expect(button(container, '이웃 신청')).toBeDefined();
    await unmount();
  });

  it('다른 섬으로 가면 내 섬에서 읽은 이웃 신청은 그 섬을 읽지 못해도 보이지 않는다', async () => {
    social.requests.mockResolvedValue({ received: [request('r1')], sent: [] });
    const me: User = { ...visitorA, id: 'owner', username: 'host' };
    const { container, rerender, unmount } = await mount(screen(view(true), me));
    await settle();
    expect(container.textContent).toContain('받은 이웃 신청');
    social.ilchons.mockRejectedValueOnce(new ApiRequestError(503, 'database', '잠시 후 다시 시도해 주세요.'));
    await rerender(screen(friendView(), me));
    await settle();
    expect(container.textContent).not.toContain('받은 이웃 신청');
    expect(button(container, '수락')).toBeUndefined();
    await unmount();
  });

  it('다른 섬으로 가면 앞 섬을 읽지 못한 문제는 그 섬을 읽는 동안 보이지 않는다', async () => {
    social.ilchons.mockRejectedValueOnce(new ApiRequestError(503, 'database', '잠시 후 다시 시도해 주세요.'))
      .mockImplementationOnce(() => new Promise(() => {}));
    const { container, rerender, unmount } = await mount(screen(view(false), null));
    await settle();
    expect(container.querySelector('[role=alert]')?.textContent).toBe('잠시 후 다시 시도해 주세요.');
    await rerender(screen(friendView(), null));
    await settle();
    expect(container.querySelector('[role=alert]')).toBeNull();
    await unmount();
  });

  it('이웃 신청 칸에는 예시 문구가 없다', async () => {
    const { container, unmount } = await mount(screen(view(false), visitorA));
    await settle();
    await act(async () => button(container, '이웃 신청')!.click());
    const placeholders = [...container.querySelectorAll('input')].map((input) => input.getAttribute('placeholder'));
    expect(placeholders).toEqual([null, null, '한마디']);
    await unmount();
  });
});
