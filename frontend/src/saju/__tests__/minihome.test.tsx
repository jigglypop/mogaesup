import { act, useEffect } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../api/client';
import type { HomeView, SajuHome, SajuVillage, User } from '../../api/types';
import { mount } from '../../__tests__/mount';
import type { Birth } from '../engine';
import { forgetLegacyHome, legacyHomeOf, readLegacyHome, useMinihome } from '../minihome';

const { mine, get, visit, update, village, save, remove } = vi.hoisted(() => ({
  mine: vi.fn(),
  get: vi.fn(),
  visit: vi.fn(),
  update: vi.fn(),
  village: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../../api/endpoints', () => ({ homeApi: { mine, get, visit, update }, sajuApi: { village, save, remove } }));
vi.mock('../../shell/Shell', () => ({ REQUESTS_CHANGED: 'mogaesup:requests' }));
let auth: { status: 'loading' | 'anonymous' | 'signedIn'; user: User | null; lapsed?: User | null } = { status: 'loading', user: null };
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => auth }));

const birth: Birth = { calendar: 'solar', year: 1990, month: 1, day: 1, leapMonth: false, time: '12:00', gender: 'male' };
const sol: User = { id: 'u1', username: 'sol', displayName: '솔이', role: 'user' };
const noeul: User = { id: 'u2', username: 'noeul', displayName: '노을이', role: 'user' };
const home = (name: string): SajuHome => ({ name, birth });
const view = (isOwner: boolean): HomeView => ({
  isOwner,
  visits: { today: 1, total: 7 },
  profile: { ownerId: 'u1', username: 'sol', ownerName: '솔이', title: '솔이의 섬', statusMessage: '', mood: 0, minime: 'man', emoji: '😊', visibility: 'public', updatedAt: '2026-11-01T00:00:00Z' },
});
const card = (user: User) => ({ id: user.id, username: user.username, displayName: user.displayName, emoji: '😊' });
const sols: SajuVillage = { saju: home('솔'), village: [{ user: card(noeul), saju: home('노을'), neighbour: true }] };

type Hook = ReturnType<typeof useMinihome>;
const settle = () => act(async () => { for (let round = 0; round < 5; round++) await new Promise((done) => setTimeout(done, 0)); });

/** The hook on a page, and what it last gave. */
async function open(username = 'sol') {
  const seen: { hook: Hook | null } = { hook: null };
  function Probe() {
    const hook = useMinihome(username);
    useEffect(() => {
      seen.hook = hook;
    });
    return null;
  }
  const mounted = await mount(<Probe />);
  await settle();
  return {
    ...mounted,
    /** Renders the page again, as a change of who is signed in does. */
    again: () => mounted.rerender(<Probe />),
    hook: () => seen.hook!,
    ready: () => (seen.hook!.state.status === 'ready' ? seen.hook!.state.minihome : null),
  };
}

describe('섬 읽기', () => {
  beforeEach(() => {
    auth = { status: 'signedIn', user: sol };
    mine.mockResolvedValue(view(true));
    get.mockResolvedValue(view(false));
    visit.mockResolvedValue(null);
    village.mockResolvedValue(sols);
  });
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('로그인 여부를 알기 전에는 묻지 않는다', async () => {
    auth = { status: 'loading', user: null };
    const page = await open();
    expect(page.hook().state).toEqual({ status: 'loading' });
    expect(village).not.toHaveBeenCalled();
    await page.unmount();
  });

  it('주인은 제 집을 한 번에 읽고, 그 집이 곧 내 집이다', async () => {
    const page = await open();
    expect(mine).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
    expect(village.mock.calls).toEqual([['sol']]);
    const minihome = page.ready()!;
    expect(minihome.owner).toEqual({ id: 'sol', name: '솔', birth });
    expect(minihome.mine).toBe(minihome.owner);
    expect(minihome.village).toEqual([{ id: 'noeul', name: '노을', birth, neighbour: true, visitable: true, shared: true }]);
    await page.unmount();
  });

  it('손님은 그 집과 제 집을 함께 읽고, 제 집을 못 읽어도 그 집은 본다', async () => {
    auth = { status: 'signedIn', user: noeul };
    village.mockImplementation(async (username: string) => (username === 'sol' ? sols : { saju: home('노을'), village: [] }));
    const page = await open();
    expect(get).toHaveBeenCalledExactlyOnceWith('sol');
    expect(village.mock.calls.map(([username]) => username).sort()).toEqual(['noeul', 'sol']);
    expect(page.ready()!.mine).toEqual({ id: 'noeul', name: '노을', birth });
    await page.unmount();

    village.mockImplementation(async (username: string) => (username === 'sol' ? sols : Promise.reject(new Error('끊김'))));
    const again = await open();
    expect(again.ready()!.owner?.name).toBe('솔');
    expect(again.ready()!.mine).toBeNull();
    await again.unmount();
  });

  it('로그인하지 않은 손님에게는 내 집이 없다', async () => {
    auth = { status: 'anonymous', user: null };
    const page = await open();
    expect(village.mock.calls).toEqual([['sol']]);
    expect(page.ready()!.mine).toBeNull();
    await page.unmount();
  });

  it('아직 짓지 않은 집은 빈 터다', async () => {
    village.mockResolvedValue({ saju: null, village: [] });
    const page = await open();
    expect(page.ready()).toMatchObject({ owner: null, mine: null, village: [] });
    await page.unmount();
  });

  it('없는 집과 닫힌 집, 닿지 않는 서버를 구분해 알린다', async () => {
    mine.mockRejectedValue(new ApiRequestError(403, 'home_private', '주인이 공개하지 않은 섬입니다.'));
    const closed = await open();
    expect(closed.hook().state).toEqual({ status: 'failed', code: 403, message: '주인이 공개하지 않은 섬입니다.' });
    await closed.unmount();
    mine.mockRejectedValue(new TypeError('Failed to fetch'));
    const down = await open();
    expect(down.hook().state).toEqual({ status: 'failed', code: 0, message: '섬을 불러오지 못했어요' });
    await down.unmount();
  });

  it('방문은 한 번 세고, 센 값이 오면 화면의 수를 바꾼다', async () => {
    let counted: (value: { today: number; total: number }) => void = () => {};
    visit.mockReturnValue(new Promise((resolve) => (counted = resolve)));
    const page = await open();
    expect(visit).toHaveBeenCalledOnce();
    expect(page.ready()!.view.visits).toEqual({ today: 1, total: 7 });
    await act(async () => counted({ today: 2, total: 8 }));
    expect(page.ready()!.view.visits).toEqual({ today: 2, total: 8 });
    await page.unmount();
  });

  it('이웃 신청에 답하면 쪽을 떠나지 않고 마을을 다시 읽는다', async () => {
    const page = await open();
    village.mockResolvedValue({ saju: home('솔'), village: [] });
    await act(async () => window.dispatchEvent(new Event('mogaesup:requests')));
    await settle();
    expect(page.ready()!.village).toEqual([]);
    // 방문은 다시 세지 않는다.
    expect(visit).toHaveBeenCalledOnce();
    // 다시 읽지 못하면 보던 것이 남는다.
    village.mockRejectedValue(new Error('끊김'));
    await act(async () => window.dispatchEvent(new Event('mogaesup:requests')));
    await settle();
    expect(page.ready()!.owner?.name).toBe('솔');
    // 이제 닫힌 집이라는 답이면 닫힌 집으로 보여 준다.
    village.mockRejectedValue(new ApiRequestError(403, 'home_private', '주인이 공개하지 않은 섬입니다.'));
    await act(async () => window.dispatchEvent(new Event('mogaesup:requests')));
    await settle();
    expect(page.hook().state).toEqual({ status: 'failed', code: 403, message: '주인이 공개하지 않은 섬입니다.' });
    await page.unmount();
  });

  it('세션이 끊겨도 보던 쪽은 그대로 두고, 다른 사람이 로그인하면 다시 읽는다', async () => {
    const page = await open();
    expect(village).toHaveBeenCalledOnce();
    auth = { status: 'anonymous', user: null, lapsed: sol };
    await page.again();
    await settle();
    expect(page.ready()!.owner?.name).toBe('솔');
    expect(village).toHaveBeenCalledOnce();
    expect(visit).toHaveBeenCalledOnce();
    // 같은 사람으로 다시 로그인해도 그대로다.
    auth = { status: 'signedIn', user: { ...sol } };
    await page.again();
    await settle();
    expect(village).toHaveBeenCalledOnce();
    // 다른 사람이면 그 사람의 눈으로 다시 읽는다.
    auth = { status: 'signedIn', user: noeul };
    await page.again();
    await settle();
    expect(get).toHaveBeenCalledExactlyOnceWith('sol');
    await page.unmount();
  });

  it('다시 읽는 사이에 주인이 바꾼 것은, 그보다 먼저 떠난 답에 덮이지 않는다', async () => {
    const page = await open();
    // 이웃 신청에 답해 다시 읽기가 떠났는데, 그 답이 오기 전에 문을 닫는다.
    let answer: (value: unknown) => void = () => {};
    mine.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await act(async () => window.dispatchEvent(new Event('mogaesup:requests')));
    update.mockResolvedValue({ ...view(true), profile: { ...view(true).profile, visibility: 'private' } });
    await act(async () => page.hook().open('private'));
    expect(page.ready()!.view.profile.visibility).toBe('private');
    // 먼저 떠난 답(아직 모두에게 열린 집)이 늦게 온다: 보여 주지 않고 한 번 더 읽는다.
    mine.mockResolvedValue({ ...view(true), profile: { ...view(true).profile, visibility: 'private' } });
    await act(async () => answer(view(true)));
    await settle();
    expect(page.ready()!.view.profile.visibility).toBe('private');
    expect(mine).toHaveBeenCalledTimes(3);
    await page.unmount();
  });

  it('주인은 집을 짓고 허물며, 서버의 답이 화면의 집이 된다', async () => {
    village.mockResolvedValue({ saju: null, village: [] });
    save.mockResolvedValue({ saju: { name: '가온', birth: { ...birth, time: null } } });
    remove.mockResolvedValue(undefined);
    const page = await open();
    await act(async () => page.hook().build('  가온  ', birth));
    expect(save).toHaveBeenCalledExactlyOnceWith({ expectedOwnerId: 'u1', name: '  가온  ', birth });
    expect(page.ready()!.owner).toEqual({ id: 'sol', name: '가온', birth: { ...birth, time: null } });
    expect(page.ready()!.mine).toBe(page.ready()!.owner);
    await act(async () => page.hook().demolish());
    expect(remove).toHaveBeenCalledExactlyOnceWith({ expectedOwnerId: 'u1' });
    expect(page.ready()).toMatchObject({ owner: null, mine: null });
    await page.unmount();
  });

  it('주인이 공개 범위를 바꾸면 서버의 답이 화면의 집이 되고, 센 방문은 그대로다', async () => {
    update.mockResolvedValue({ ...view(true), visits: { today: 0, total: 0 }, profile: { ...view(true).profile, visibility: 'private' } });
    const page = await open();
    await act(async () => page.hook().open('private'));
    expect(update).toHaveBeenCalledExactlyOnceWith({ expectedOwnerId: 'u1', visibility: 'private' });
    expect(page.ready()!.view.profile.visibility).toBe('private');
    expect(page.ready()!.view.visits).toEqual({ today: 1, total: 7 });
    await page.unmount();
  });

  it('손님은 남의 집을 짓지도 허물지도, 여닫지도 못한다', async () => {
    auth = { status: 'signedIn', user: noeul };
    const page = await open();
    await act(async () => {
      await page.hook().build('노을', birth);
      await page.hook().demolish();
      await page.hook().open('private');
    });
    expect(save).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    await page.unmount();
  });

  it('주인이 바꾼 것의 답이 다른 섬으로 간 뒤에 오면, 그 섬에 섞이지 않는다', async () => {
    const noeulView: HomeView = { ...view(false), profile: { ...view(false).profile, ownerId: 'u2', username: 'noeul', ownerName: '노을이', title: '노을이의 섬' } };
    get.mockImplementation(async (username: string) => (username === 'noeul' ? noeulView : view(false)));
    village.mockImplementation(async (username: string) => (username === 'noeul' ? { saju: home('노을'), village: [] } : sols));
    const seen: { hook: Hook | null } = { hook: null };
    function Probe({ username }: { username: string }) {
      const hook = useMinihome(username);
      useEffect(() => {
        seen.hook = hook;
      });
      return null;
    }
    const ready = () => (seen.hook!.state.status === 'ready' ? seen.hook!.state.minihome : null);
    const page = await mount(<Probe username="sol" />);
    await settle();
    expect(ready()!.view.isOwner).toBe(true);
    // 솔이 제 섬의 문을 닫고 집을 다시 짓는데, 답이 오기 전에 노을의 섬으로 간다.
    let closed: (value: unknown) => void = () => {};
    let built: (value: unknown) => void = () => {};
    update.mockReturnValue(new Promise((resolve) => (closed = resolve)));
    save.mockReturnValue(new Promise((resolve) => (built = resolve)));
    const { open: close, build } = seen.hook!;
    const sent: Promise<void>[] = [];
    await act(async () => void sent.push(close('private'), build('가온', birth)));
    await page.rerender(<Probe username="noeul" />);
    await settle();
    expect(ready()!.view.profile.username).toBe('noeul');
    await act(async () => {
      closed({ ...view(true), profile: { ...view(true).profile, visibility: 'private' } });
      built({ saju: home('가온') });
      await Promise.all(sent);
    });
    await settle();
    // 노을의 섬은 노을의 것 그대로다.
    expect(ready()!.view.profile).toEqual(noeulView.profile);
    expect(ready()!.owner).toEqual({ id: 'noeul', name: '노을', birth });
    expect(ready()!.mine).toEqual({ id: 'sol', name: '솔', birth });
    await page.unmount();
  });
});

describe('이 브라우저에 남아 있던 집', () => {
  const KEY = 'saju:village';
  const stored = (me: unknown) => JSON.stringify({ me, entries: [], bridges: ['sol'] });
  afterEach(() => localStorage.clear());

  it('이름과 생일을 읽고, 긴 이름은 열두 자에서 자른다', () => {
    expect(legacyHomeOf(stored({ id: 'me', name: '  가온  ', birth, sample: false }))).toEqual({ name: '가온', birth });
    expect(legacyHomeOf(stored({ name: '가온이라는아주아주긴이름입니다', birth }))?.name).toBe('가온이라는아주아주긴이름');
    // 양력 생일의 윤달 표시는 뜻이 없다.
    expect(legacyHomeOf(stored({ name: '가온', birth: { ...birth, leapMonth: true } }))?.birth.leapMonth).toBe(false);
  });

  it('모양이 다르거나 달력에 없는 것은 읽지 않는다', () => {
    expect(legacyHomeOf(null)).toBeNull();
    expect(legacyHomeOf('{')).toBeNull();
    expect(legacyHomeOf('[]')).toBeNull();
    expect(legacyHomeOf(stored(null))).toBeNull();
    expect(legacyHomeOf(stored({ name: '', birth }))).toBeNull();
    expect(legacyHomeOf(stored({ name: '가온', birth: { ...birth, month: 13 } }))).toBeNull();
    expect(legacyHomeOf(stored({ name: '가온', birth: { ...birth, time: '25:00' } }))).toBeNull();
    expect(legacyHomeOf(stored({ name: '가온', birth: { ...birth, gender: 'x' } }))).toBeNull();
    expect(legacyHomeOf(stored({ name: '가온', birth: { ...birth, year: 2050 } }))).toBeNull();
  });

  it('저장소에서 읽고, 집을 지은 뒤에는 지운다', () => {
    expect(readLegacyHome()).toBeNull();
    localStorage.setItem(KEY, stored({ name: '가온', birth }));
    expect(readLegacyHome()).toEqual({ name: '가온', birth });
    forgetLegacyHome();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(readLegacyHome()).toBeNull();
  });
});
