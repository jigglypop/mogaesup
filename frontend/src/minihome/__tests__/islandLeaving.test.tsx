import { act, useEffect, useRef } from 'react';

import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../api/client';
import { mount, type } from '../../__tests__/mount';
import { SearchBox } from '../../shell/Shell';
import type { IslandSaver } from '../edit/save';
import { LEAVE_QUESTION, useIslandLeaving } from '../edit/useIslandLeaving';
import { IslandTooLargeError } from '../persistence';
import { fakeWorld, ready } from './fakeWorld';

/** What the island under test exposes: its leaving, the flag the island's unmount reads, and the app's navigation. */
let probe: { leave: (to: string) => void; discarding: { current: boolean }; go: (to: string) => void };
/** What the island's unmount found the flag at: whether it dropped the edits (true) or held them to save later. */
let leftDiscarding: boolean | null = null;

/** The owner's island as Minihome wires it: `/@me` and its editor `/@me/edit` are one mount. */
function Island({ saver, onReloaded }: { saver: IslandSaver; onReloaded: () => void }) {
  const { pathname } = useLocation();
  const editing = pathname.endsWith('/edit');
  const discarding = useRef(false);
  // Declared ahead of the leaving, as the island's own unmount is.
  useEffect(() => () => {
    leftDiscarding = discarding.current;
  }, []);
  const { leave } = useIslandLeaving({ saver, save: saver.save, owner: true, decorating: editing, editing, username: 'me', discarding, onReloaded });
  probe = { leave, discarding, go: useNavigate() };
  return (
    <>
      <p className="where">{pathname}</p>
      <Link to="/explore">둘러보기</Link>
      <Link to="/@me/edit">꾸미기</Link>
      <SearchBox />
    </>
  );
}

const app = (saver: IslandSaver, entry: string, onReloaded = vi.fn()) =>
  mount(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/@me/*" element={<Island saver={saver} onReloaded={onReloaded} />} />
        <Route path="*" element={<p className="where">elsewhere</p>} />
      </Routes>
    </MemoryRouter>,
  );
const where = (container: HTMLElement) => container.querySelector('.where')?.textContent;
const settle = () => act(async () => { for (let round = 0; round < 5; round++) await new Promise((done) => setTimeout(done, 0)); });
const offline = () => new TypeError('Failed to fetch');

afterEach(() => {
  vi.restoreAllMocks();
  leftDiscarding = null;
  window.history.replaceState(null, '', '/');
});

describe('저장하지 못한 편집을 두고 나가기', () => {
  it('버리고 꾸미기를 나와 같은 섬에 남으면 저장된 섬을 다시 읽고, 다음에 나갈 때는 버리지 않는다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.failing.with = offline();
    world.edit();
    saver.changed();
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onReloaded = vi.fn();
    const { container, unmount } = await app(saver, '/@me/edit', onReloaded);

    await act(async () => probe.leave('/@me'));
    await settle();
    expect(ask).toHaveBeenCalledExactlyOnceWith(LEAVE_QUESTION);
    expect(where(container)).toBe('/@me');
    // Not saved again on the way out (the owner chose to go without it); the stored island is read over it instead.
    expect(world.system.save).toHaveBeenCalledTimes(1);
    expect(world.system.load).toHaveBeenCalledTimes(2);
    expect(onReloaded).toHaveBeenCalledTimes(1);
    expect(saver.getState()).toMatchObject({ dirty: false, problem: null });
    expect(probe.discarding.current).toBe(false);

    // Decorating again, then leaving the island: these edits are held to be saved later, not dropped.
    await act(async () => probe.go('/@me/edit'));
    world.edit();
    saver.changed();
    await act(async () => probe.go('/explore'));
    expect(where(container)).toBe('elsewhere');
    expect(leftDiscarding).toBe(false);
    saver.dispose();
    await unmount();
  });

  it('남기로 하면 편집을 그대로 두고 꾸미기에 남는다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.failing.with = new IslandTooLargeError(3 * 1024 * 1024);
    world.edit();
    saver.changed();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { container, unmount } = await app(saver, '/@me/edit');
    await act(async () => probe.leave('/@me'));
    await settle();
    expect(where(container)).toBe('/@me/edit');
    expect(saver.getState().dirty).toBe(true);
    expect(probe.discarding.current).toBe(false);
    expect(world.system.load).toHaveBeenCalledTimes(1);
    saver.dispose();
    await unmount();
  });
});

describe('주인을 기다리는 편집(충돌·너무 큼)이 있는 섬', () => {
  const conflicted = async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.answers.push(new ApiRequestError(409, 'revision_conflict', ''));
    world.edit();
    saver.changed();
    await saver.save();
    expect(saver.getState().conflict).toBe(true);
    return { world, saver };
  };
  const pop = (path: string, state: unknown) => {
    window.history.replaceState(state, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state }));
  };

  it('꾸미기 밖에서도 섬을 떠나는 링크는 먼저 묻고, 같은 섬의 꾸미기로 가는 링크는 묻지 않는다', async () => {
    const { saver } = await conflicted();
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { container, unmount } = await app(saver, '/@me');
    const link = (text: string) => [...container.querySelectorAll('a')].find((anchor) => anchor.textContent === text)!;

    await act(async () => link('둘러보기').click());
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(where(container)).toBe('/@me');

    await act(async () => link('꾸미기').click());
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(where(container)).toBe('/@me/edit');
    saver.dispose();
    await unmount();
  });

  it('검색창에서 Enter로 섬을 떠나도 링크처럼 먼저 묻고, 그만두면 남고, 떠나겠다면 편집을 버리고 간다', async () => {
    const { saver } = await conflicted();
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { container, unmount } = await app(saver, '/@me');
    await type(container.querySelector<HTMLInputElement>('input[aria-label="섬이나 사람 찾기"]')!, '모개');
    const search = () => act(async () => {
      container.querySelector('form[role=search]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await search();
    await settle();
    expect(ask).toHaveBeenCalledExactlyOnceWith(LEAVE_QUESTION);
    expect(where(container)).toBe('/@me');
    expect(probe.discarding.current).toBe(false);

    await search();
    await settle();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(where(container)).toBe('elsewhere');
    expect(leftDiscarding).toBe(true);
    saver.dispose();
    await unmount();
  });

  it('잃을 편집이 없으면 검색창 Enter는 묻지 않고 바로 간다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    const ask = vi.spyOn(window, 'confirm');
    const { container, unmount } = await app(saver, '/@me');
    await act(async () => {
      container.querySelector('form[role=search]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(ask).not.toHaveBeenCalled();
    expect(where(container)).toBe('elsewhere');
    saver.dispose();
    await unmount();
  });

  it('뒤로 가기로 섬을 떠나려 하면 먼저 묻고, 떠나겠다면 편집을 버리고 나간다', async () => {
    const { saver } = await conflicted();
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    window.history.replaceState({ idx: 2 }, '', '/@me/edit');
    const { unmount } = await app(saver, '/@me/edit');

    pop('/explore', { idx: 1 });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledExactlyOnceWith(1);
    expect(probe.discarding.current).toBe(false);

    window.history.replaceState({ idx: 2 }, '', '/@me/edit');
    pop('/explore', { idx: 1 });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(probe.discarding.current).toBe(true);
    saver.dispose();
    await unmount();
  });

  it('꾸미기 밖에서도 페이지를 닫거나 새로 고치기 전에 묻고, 편집을 정리하면 더 묻지 않는다', async () => {
    const { saver } = await conflicted();
    const closePage = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const { unmount } = await app(saver, '/@me');
    expect(closePage()).toBe(true);
    // The owner takes the stored island: nothing is left to lose.
    await act(async () => { await saver.reloadLatest(); });
    expect(closePage()).toBe(false);
    saver.dispose();
    await unmount();
  });

  it('나중에라도 저장될 편집이면 뒤로 가기를 막지 않는다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.failing.with = offline();
    world.edit();
    saver.changed();
    await saver.save();
    const ask = vi.spyOn(window, 'confirm');
    const { unmount } = await app(saver, '/@me/edit');
    pop('/explore', { idx: 1 });
    expect(ask).not.toHaveBeenCalled();
    saver.dispose();
    await unmount();
  });
});
