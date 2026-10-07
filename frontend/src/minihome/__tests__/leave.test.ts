import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../api/client';
import { appDestination, guardHistory, hasUnsaved, HeldSaveError, heldSavesSettled, leaveIsland, onIsland, waitsForOwner } from '../edit/leave';
import type { SaverState } from '../edit/save';
import { IslandTooLargeError } from '../persistence';
import { fakeWorld, ready } from './fakeWorld';

const offline = () => new TypeError('Failed to fetch');
/** What closing the page does: the browser asks when a handler cancels the event. */
const closePage = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

describe('나갈 때 저장하지 않은 변경', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('저장하지 않은 것이 없으면 바로 놓아 준다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    const release = vi.fn();
    leaveIsland(saver, release);
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledTimes(1);
    expect(world.system.save).not.toHaveBeenCalled();
    expect(closePage()).toBe(false);
  });

  it('저장하지 않은 변경은 저장이 끝난 뒤에 놓아 준다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.edit();
    saver.changed();
    const release = vi.fn();
    leaveIsland(saver, release);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(world.system.save).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(saver.getState().dirty).toBe(false);
  });

  it('저장이 안 되면 놓지 않고, 연결이 돌아와 저장되면 그때 놓아 준다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.failing.with = offline();
    world.edit();
    saver.changed();
    const release = vi.fn();
    leaveIsland(saver, release);
    await vi.advanceTimersByTimeAsync(0);
    expect(world.system.save).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    // 페이지를 닫으려 하면 먼저 묻는다.
    expect(closePage()).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(release).not.toHaveBeenCalled();
    expect(world.system.save.mock.calls.length).toBeGreaterThan(1);

    world.failing.with = null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(release).toHaveBeenCalledTimes(1);
    expect(saver.getState()).toMatchObject({ dirty: false, problem: null });
    const saves = world.system.save.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(world.system.save).toHaveBeenCalledTimes(saves);
    expect(closePage()).toBe(false);
  });

  it('저장을 기다리는 섬이 여럿이면 마지막 섬이 놓일 때까지 닫기 전에 묻는다', async () => {
    const [first, second] = [fakeWorld(), fakeWorld()];
    const savers = [await ready(first), await ready(second)];
    for (const [index, world] of [first, second].entries()) {
      world.failing.with = offline();
      world.edit();
      savers[index]!.changed();
    }
    const releases = [vi.fn(), vi.fn()];
    savers.forEach((saver, index) => leaveIsland(saver, releases[index]!));
    await vi.advanceTimersByTimeAsync(0);
    // 닫으려 하면 둘 다 바로 다시 저장해 본다. 둘째 실패라 다음 시도는 30초 뒤다.
    expect(closePage()).toBe(true);
    expect(first.system.save).toHaveBeenCalledTimes(2);

    first.failing.with = null;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(releases[1]).not.toHaveBeenCalled();
    expect(closePage()).toBe(true);

    // 이번에는 닫으려는 순간의 저장이 성공한다.
    second.failing.with = null;
    expect(closePage()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(releases[1]).toHaveBeenCalledTimes(1);
    expect(closePage()).toBe(false);
  });

  it('다른 곳에서 먼저 저장해 충돌이 났다면 기다려도 저장할 수 없으니 놓아 준다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.answers.push(new ApiRequestError(409, 'revision_conflict', ''));
    world.edit();
    saver.changed();
    const release = vi.fn();
    leaveIsland(saver, release);
    await vi.advanceTimersByTimeAsync(0);
    expect(saver.getState().conflict).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(closePage()).toBe(false);
  });

  it('섬이 너무 커서 저장되지 않는다면 다시 시도해도 소용없으니 놓아 준다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.answers.push(new IslandTooLargeError(3 * 1024 * 1024));
    world.edit();
    saver.changed();
    const release = vi.fn();
    leaveIsland(saver, release);
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('로그인이 풀려 저장하지 못한 변경은 놓지 않고 기다리다, 다시 로그인해 저장되면 놓아 준다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.failing.with = new ApiRequestError(401, 'login_required', '');
    world.edit();
    saver.changed();
    const release = vi.fn();
    leaveIsland(saver, release);
    await vi.advanceTimersByTimeAsync(0);
    expect(saver.getState().problem?.kind).toBe('session');
    expect(release).not.toHaveBeenCalled();
    expect(closePage()).toBe(true);
    const sent = world.system.save.mock.calls.length;
    // Nothing retries on a clock: each save would be refused until the owner signs in.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(world.system.save).toHaveBeenCalledTimes(sent);
    expect(release).not.toHaveBeenCalled();

    // Signing in again as the owner flushes it (followSessionOwner's resume).
    world.failing.with = null;
    await saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledTimes(1);
    expect(closePage()).toBe(false);
  });

  it('400·404처럼 다시 보내도 같은 답이 올 실패는 붙잡아 두지 않고 놓아 준다', async () => {
    for (const status of [400, 404]) {
      const world = fakeWorld();
      const saver = await ready(world);
      world.failing.with = new ApiRequestError(status, 'http_error', '');
      world.edit();
      saver.changed();
      const release = vi.fn();
      leaveIsland(saver, release);
      await vi.advanceTimersByTimeAsync(0);
      expect(release).toHaveBeenCalledTimes(1);
      expect(closePage()).toBe(false);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(world.system.save).toHaveBeenCalledTimes(1);
    }
  });

  it('섬을 끝까지 올리지 못한 400 incomplete_world는 버리지 않고 붙잡아 두었다가, 다시 저장되면 놓아 준다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.failing.with = new ApiRequestError(400, 'incomplete_world', '섬 데이터를 끝까지 받지 못했습니다. 다시 저장해 주세요.');
    world.edit();
    saver.changed();
    const release = vi.fn();
    leaveIsland(saver, release);
    await vi.advanceTimersByTimeAsync(0);
    expect(release).not.toHaveBeenCalled();
    expect(waitsForOwner(saver.getState())).toBe(false);
    // Closing the page asks first (and tries once more, on the same slow line).
    expect(closePage()).toBe(true);
    expect(world.system.save).toHaveBeenCalledTimes(2);

    world.failing.with = null;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(world.system.save).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(1);
    expect(closePage()).toBe(false);
  });

  it('같은 섬을 다시 열 때는 붙잡아 둔 섬의 저장이 끝나기를 기다린다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.failing.with = offline();
    world.edit();
    saver.changed();
    leaveIsland(saver, vi.fn(), false, 'mogae');
    await vi.advanceTimersByTimeAsync(0);
    let finish!: () => void;
    world.system.save.mockImplementationOnce(() => new Promise<void>((done) => (finish = done)));
    void saver.flush();
    expect(saver.getState().saving).toBe(true);

    const settled = vi.fn();
    void heldSavesSettled('mogae').then(settled);
    const other = vi.fn();
    void heldSavesSettled('other-island').then(other);
    await vi.advanceTimersByTimeAsync(0);
    expect(other).toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalled();
  });

  it('같은 섬을 다시 열 때 재시도를 기다리는 저장은 바로 다시 보내고, 저장된 뒤에 연다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.failing.with = offline();
    world.edit();
    saver.changed();
    const release = vi.fn();
    leaveIsland(saver, release, false, 'mogae');
    await vi.advanceTimersByTimeAsync(0);
    // Failed once; the next try is ten seconds away and nothing is saving now.
    expect(world.system.save).toHaveBeenCalledTimes(1);
    expect(saver.getState().saving).toBe(false);

    world.failing.with = null;
    const settled = vi.fn();
    void heldSavesSettled('mogae').then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(world.system.save).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('다시 보내도 저장되지 않으면 섬을 열지 않고 실패로 알린다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.failing.with = offline();
    world.edit();
    saver.changed();
    const release = vi.fn();
    leaveIsland(saver, release, false, 'mogae');
    await vi.advanceTimersByTimeAsync(0);
    const result = heldSavesSettled('mogae').then(() => 'opened', (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBeInstanceOf(HeldSaveError);
    expect(world.system.save).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
    // Still held, still retried in the background.
    world.failing.with = null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(release).toHaveBeenCalledTimes(1);
    await expect(heldSavesSettled('mogae')).resolves.toBeUndefined();
  });

  it('다시 로그인을 기다리는 저장은 다시 보내지 않고 섬을 연다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.failing.with = new ApiRequestError(401, 'login_required', '');
    world.edit();
    saver.changed();
    leaveIsland(saver, vi.fn(), false, 'mogae');
    await vi.advanceTimersByTimeAsync(0);
    expect(saver.getState().problem?.kind).toBe('session');
    await expect(heldSavesSettled('mogae')).resolves.toBeUndefined();
    expect(world.system.save).toHaveBeenCalledTimes(1);
    saver.dispose();
  });

  it('주인이 변경을 버리고 나가겠다고 하면 저장하지 않고 바로 놓아 준다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.failing.with = offline();
    world.edit();
    saver.changed();
    const release = vi.fn();
    leaveIsland(saver, release, true);
    expect(release).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(world.system.save).not.toHaveBeenCalled();
    expect(closePage()).toBe(false);
  });

  it('저장 중에 나가면 그 저장이 끝난 뒤에 놓아 준다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    let finish!: () => void;
    world.system.save.mockImplementationOnce(() => new Promise<void>((done) => (finish = done)));
    world.edit();
    void saver.save();
    expect(saver.getState().saving).toBe(true);
    const release = vi.fn();
    leaveIsland(saver, release);
    await vi.advanceTimersByTimeAsync(0);
    expect(release).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('세션이 끝난 saver는 백그라운드 재시도와 페이지 종료 경고를 즉시 해제한다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.failing.with = offline(); world.edit(); saver.changed();
    const release = vi.fn();
    leaveIsland(saver, release);
    await vi.advanceTimersByTimeAsync(0);
    expect(closePage()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    saver.dispose();
    const sent = world.system.save.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    await saver.save(); await saver.flush(); await saver.overwrite();
    expect(release).toHaveBeenCalledTimes(1);
    expect(world.system.save).toHaveBeenCalledTimes(sent);
    expect(closePage()).toBe(false);
  });
});

describe('저장하지 않은 것', () => {
  const state = (changes: Partial<SaverState>): SaverState => ({
    phase: 'ready',
    saving: false,
    dirty: false,
    conflict: false,
    problem: null,
    lastSavedAt: null,
    bytes: null,
    ...changes,
  });

  it('고치고 아직 저장하지 않았거나 저장하는 중일 때다', () => {
    expect(hasUnsaved(state({}))).toBe(false);
    expect(hasUnsaved(state({ dirty: true }))).toBe(true);
    expect(hasUnsaved(state({ saving: true }))).toBe(true);
  });

  it('섬을 불러오기 전이나 불러오지 못했을 때는 잃을 것이 없다', () => {
    expect(hasUnsaved(state({ phase: 'loading', dirty: true }))).toBe(false);
    expect(hasUnsaved(state({ phase: 'loadFailed', dirty: true }))).toBe(false);
  });

  it('주인을 기다리는 변경은 충돌이나 고쳐야 저장되는 실패에 걸린 것뿐이다', () => {
    const tooLarge = { kind: 'tooLarge', message: '' } as const;
    expect(waitsForOwner(state({ dirty: true, conflict: true }))).toBe(true);
    expect(waitsForOwner(state({ dirty: true, problem: tooLarge }))).toBe(true);
    expect(waitsForOwner(state({ dirty: true, problem: { kind: 'invalid', message: '' } }))).toBe(true);
    // Saved later on its own, or once the owner signs in again; or nothing to lose; or still on its way.
    expect(waitsForOwner(state({ dirty: true, problem: { kind: 'network', message: '' } }))).toBe(false);
    expect(waitsForOwner(state({ dirty: true, problem: { kind: 'session', message: '' } }))).toBe(false);
    expect(waitsForOwner(state({ dirty: true }))).toBe(false);
    expect(waitsForOwner(state({ problem: tooLarge }))).toBe(false);
    expect(waitsForOwner(state({ dirty: true, saving: true, problem: tooLarge }))).toBe(false);
  });
});

describe('같은 섬에 머무는 경로', () => {
  it('섬과 그 꾸미기 화면이면 대소문자와 쿼리에 상관없이 같은 섬이다', () => {
    expect(onIsland('/@mogae', 'mogae')).toBe(true);
    expect(onIsland('/@Mogae/', 'mogae')).toBe(true);
    expect(onIsland('/@mogae/edit?tab=1#top', 'mogae')).toBe(true);
    expect(onIsland('/%40mogae/edit', 'mogae')).toBe(true);
    expect(onIsland('/@mogae/edit/more', 'mogae')).toBe(false);
    expect(onIsland('/@mogae/other', 'mogae')).toBe(false);
    expect(onIsland('/@other', 'mogae')).toBe(false);
    expect(onIsland('/explore', 'mogae')).toBe(false);
    expect(onIsland('/%E0%A4%A', 'mogae')).toBe(false);
  });
});

describe('뒤로·앞으로 가기로 섬을 떠날 때', () => {
  /** The router's own listener, added before the guard as the app's is. */
  const router = vi.fn();
  let go: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    window.addEventListener('popstate', router);
    go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
    window.history.replaceState({ idx: 4, key: 'edit', usr: null }, '', '/@me/edit');
  });
  afterEach(() => {
    window.removeEventListener('popstate', router);
    router.mockReset();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });
  /** What the browser does on Back or Forward: the address and state change, then popstate. */
  const pop = (path: string, state: unknown) => {
    window.history.replaceState(state, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state }));
  };

  it('그만두면 라우터가 듣지 못하게 하고 원래 자리로 돌아간다', () => {
    const ask = vi.fn(() => false);
    const leaving = vi.fn();
    const stop = guardHistory({ stays: (path) => onIsland(path, 'me'), ask, leaving });
    pop('/explore', { idx: 3, key: 'explore', usr: null });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(router).not.toHaveBeenCalled();
    expect(leaving).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledExactlyOnceWith(1);

    // Forward past it, two entries on: two back.
    pop('/character', { idx: 6, key: 'character', usr: null });
    expect(go).toHaveBeenLastCalledWith(-2);
    stop();
  });

  it('주인이 떠나겠다고 하면 그대로 두고 알린다', () => {
    const leaving = vi.fn();
    const stop = guardHistory({ stays: (path) => onIsland(path, 'me'), ask: () => true, leaving });
    pop('/explore', { idx: 3, key: 'explore', usr: null });
    expect(leaving).toHaveBeenCalledTimes(1);
    expect(router).toHaveBeenCalledTimes(1);
    expect(go).not.toHaveBeenCalled();
    stop();
  });

  it('같은 섬 안의 이동은 묻지 않고, 그 자리를 새 기준으로 삼는다', () => {
    const ask = vi.fn(() => false);
    const stop = guardHistory({ stays: (path) => onIsland(path, 'me'), ask, leaving: vi.fn() });
    pop('/@me', { idx: 3, key: 'island', usr: null });
    expect(ask).not.toHaveBeenCalled();
    expect(router).toHaveBeenCalledTimes(1);
    pop('/explore', { idx: 2, key: 'explore', usr: null });
    expect(go).toHaveBeenCalledExactlyOnceWith(1);
    stop();
  });

  it('라우터의 위치를 모르면 주소를 원래대로 되돌려 놓는다', () => {
    const stop = guardHistory({ stays: (path) => onIsland(path, 'me'), ask: () => false, leaving: vi.fn() });
    pop('/explore', null);
    expect(go).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/@me/edit');
    expect(window.history.state).toEqual({ idx: 4, key: 'edit', usr: null });
    stop();
  });

  it('지켜보기를 멈추면 더 묻지 않는다', () => {
    const ask = vi.fn(() => false);
    guardHistory({ stays: () => false, ask, leaving: vi.fn() })();
    pop('/explore', { idx: 3 });
    expect(ask).not.toHaveBeenCalled();
    expect(router).toHaveBeenCalledTimes(1);
  });
});

describe('링크를 눌러 앱 안에서 가는 곳', () => {
  const here = { href: 'http://mogae.test/@me/edit', origin: 'http://mogae.test', pathname: '/@me/edit', search: '' };
  const container = () => document.body.appendChild(document.createElement('div'));
  afterEach(() => document.body.replaceChildren());
  const click = (target: Element, changes: Partial<MouseEventInit> = {}) => {
    let destination: string | null | undefined;
    target.addEventListener(
      'click',
      (event) => {
        destination = appDestination(event as MouseEvent, here);
        event.preventDefault();
      },
      { once: true },
    );
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...changes }));
    return destination;
  };
  const link = (href: string, attributes: Record<string, string> = {}) => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', href);
    for (const [name, value] of Object.entries(attributes)) anchor.setAttribute(name, value);
    container().append(anchor);
    return anchor;
  };

  it('같은 사이트의 다른 쪽이면 그 경로를 준다', () => {
    expect(click(link('/@mogae'))).toBe('/@mogae');
    expect(click(link('/explore?q=%EB%AA%A8#top'))).toBe('/explore?q=%EB%AA%A8#top');
    expect(click(link('http://mogae.test/character'))).toBe('/character');
  });

  it('링크 안쪽 요소를 눌러도 링크를 찾는다', () => {
    const anchor = link('/character');
    const label = anchor.appendChild(document.createElement('span'));
    expect(click(label)).toBe('/character');
  });

  it('이 쪽을 가리키거나 해시만 바꾸는 링크는 가는 곳이 아니다', () => {
    expect(click(link('/@me/edit'))).toBeNull();
    expect(click(link('#help'))).toBeNull();
    expect(click(link('/@me/edit#help'))).toBeNull();
  });

  it('새 탭, 다른 사이트, 내려받기는 앱 안에서 가는 것이 아니다', () => {
    expect(click(link('/explore', { target: '_blank' }))).toBeNull();
    expect(click(link('https://example.com/'))).toBeNull();
    expect(click(link('/file.glb', { download: '' }))).toBeNull();
    expect(click(link('/explore', { target: '_self' }))).toBe('/explore');
  });

  it('보통의 왼쪽 클릭이 아니면 브라우저에 맡긴다', () => {
    const anchor = link('/explore');
    for (const changes of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }]) {
      expect(click(anchor, changes)).toBeNull();
    }
  });

  it('링크가 아닌 곳이나 이미 처리된 클릭은 아니다', () => {
    expect(click(container())).toBeNull();
    const anchor = link('/explore');
    anchor.addEventListener('click', (event) => event.preventDefault(), { capture: true });
    expect(click(anchor)).toBeNull();
  });
});
