import { act, useEffect, type ReactNode } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeView, User, VisitCounter } from '../../api/types';
import { mount } from '../../__tests__/mount';
import type { MinihomeProps } from '../../minihome/Minihome';
import { MinihomePage } from '../MinihomePage';

const { mine, get, visit, items, looks, opened, closed } = vi.hoisted(() => ({
  mine: vi.fn(),
  get: vi.fn(),
  visit: vi.fn(),
  items: vi.fn(),
  looks: vi.fn(),
  opened: vi.fn(),
  closed: vi.fn(),
}));
vi.mock('../../api/endpoints', () => ({ homeApi: { mine, get, visit }, catalogApi: { items }, lookApi: { mine: looks } }));
vi.mock('../../minihome/Minihome', () => ({
  default: function Island({ view, viewer }: MinihomeProps) {
    useEffect(() => {
      opened(view.isOwner);
      return () => closed();
    }, [view]);
    return <p className="island" data-visits={view.visits.today}>{viewer?.username ?? '-'}</p>;
  },
}));
vi.mock('../../minihome/figures', () => ({ FALLBACK_MINIME: 'man', prefetchModels: () => {} }));
vi.mock('../../minihome/character', () => ({ playerModelUrl: () => 'gltf/man.glb' }));
vi.mock('../../shell/Shell', () => ({ PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
let auth: { status: 'loading' | 'anonymous' | 'signedIn'; user: User | null; lapsed: User | null } = { status: 'loading', user: null, lapsed: null };
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => auth, useOptionalAuth: () => null }));

const mogae: User = { id: 'u1', username: 'mogae', displayName: '모개', role: 'user' };
const other: User = { id: 'u2', username: 'other', displayName: '다른 이', role: 'user' };
const view = (isOwner: boolean): HomeView => ({
  isOwner,
  visits: { today: 1, total: 1 },
  profile: {
    ownerId: 'u1',
    username: 'mogae',
    ownerName: '모개',
    title: '모개숲',
    statusMessage: '',
    mood: 0,
    minime: 'man',
    emoji: '😊',
    visibility: 'public',
    updatedAt: '2026-10-01T00:00:00Z',
  },
});
const settle = () => act(async () => { for (let round = 0; round < 5; round++) await new Promise((done) => setTimeout(done, 0)); });
const page = (editing = true) => (
  <MemoryRouter initialEntries={[editing ? '/@mogae/edit' : '/@mogae']}>
    <MinihomePage username="mogae" editing={editing} />
  </MemoryRouter>
);

describe('섬 화면과 세션', () => {
  afterEach(() => {
    for (const mock of [mine, get, visit, items, looks, opened, closed]) mock.mockReset();
    auth = { status: 'loading', user: null, lapsed: null };
  });
  const serve = () => {
    mine.mockResolvedValue(view(true));
    get.mockResolvedValue(view(false));
    visit.mockResolvedValue(null);
    items.mockResolvedValue({ items: [] });
    looks.mockResolvedValue({ look: null });
  };

  it('꾸미는 중에 세션이 풀려도 섬을 다시 불러오지 않고 그대로 두며, 같은 사람이 다시 로그인해도 그대로다', async () => {
    serve();
    auth = { status: 'signedIn', user: mogae, lapsed: null };
    const { container, rerender, unmount } = await mount(page());
    await settle();
    expect(opened).toHaveBeenCalledExactlyOnceWith(true);

    auth = { status: 'anonymous', user: null, lapsed: mogae };
    await rerender(page());
    await settle();
    expect(closed).not.toHaveBeenCalled();
    expect(mine).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.island')?.textContent).toBe('-');

    auth = { status: 'signedIn', user: mogae, lapsed: null };
    await rerender(page());
    await settle();
    expect(closed).not.toHaveBeenCalled();
    expect(mine).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.island')?.textContent).toBe('mogae');
    await unmount();
  });

  it('세션이 풀린 뒤 다른 사람이 로그인하면 그 사람으로 섬을 새로 연다', async () => {
    serve();
    auth = { status: 'signedIn', user: mogae, lapsed: null };
    const { rerender, unmount } = await mount(page());
    await settle();
    auth = { status: 'anonymous', user: null, lapsed: mogae };
    await rerender(page());
    await settle();
    auth = { status: 'signedIn', user: other, lapsed: null };
    await rerender(page());
    await settle();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('mogae');
    await unmount();
  });

  it('세션이 풀린 채 새로 열면 방문자로 연다', async () => {
    serve();
    auth = { status: 'anonymous', user: null, lapsed: mogae };
    const { unmount } = await mount(page(false));
    await settle();
    expect(mine).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith('mogae');
    expect(opened).toHaveBeenCalledExactlyOnceWith(false);
    await unmount();
  });

  it('방문 집계를 기다리지 않고 섬을 열고, 집계가 오면 그 수를 보인다', async () => {
    serve();
    let count!: (value: VisitCounter) => void;
    visit.mockReturnValue(new Promise<VisitCounter>((resolve) => { count = resolve; }));
    auth = { status: 'signedIn', user: other, lapsed: null };
    const { container, unmount } = await mount(page(false));
    await settle();
    expect(container.querySelector('.island')?.getAttribute('data-visits')).toBe('1');
    await act(async () => count({ today: 7, total: 30 }));
    expect(container.querySelector('.island')?.getAttribute('data-visits')).toBe('7');
    await unmount();
  });

  it('방문 집계가 실패해도 섬은 그대로 열린다', async () => {
    serve();
    visit.mockRejectedValue(new Error('offline'));
    auth = { status: 'signedIn', user: other, lapsed: null };
    const { container, unmount } = await mount(page(false));
    await settle();
    expect(container.querySelector('.island')?.getAttribute('data-visits')).toBe('1');
    await unmount();
  });

  it('꾸미기 서랍의 스튜디오 가구 목록은 섬 주인에게만 받는다', async () => {
    serve();
    const kinds = () => items.mock.calls.map(([kind]) => kind);
    auth = { status: 'signedIn', user: other, lapsed: null };
    const visitor = await mount(page(false));
    await settle();
    expect(kinds()).not.toContain('furniture');
    await visitor.unmount();

    auth = { status: 'signedIn', user: mogae, lapsed: null };
    const owner = await mount(page(false));
    await settle();
    expect(kinds()).toContain('furniture');
    await owner.unmount();
  });
});
