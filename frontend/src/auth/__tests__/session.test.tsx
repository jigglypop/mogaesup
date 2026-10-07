import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError, ApiTimeoutError } from '../../api/client';
import type { Credentials, Registration, User } from '../../api/types';
import { FakeChannel } from '../../__tests__/broadcast';
import { mount } from '../../__tests__/mount';
import { Loading } from '../../pages/Loading';
import { AuthProvider, SESSION_RENEW_MS, useAuth } from '../AuthProvider';
import { draftKey } from '../drafts';
import { SESSION_CHANNEL } from '../otherTabs';
import { followSession, SESSION_RETRY_MS, SESSION_UNREACHABLE_AFTER } from '../session';
import {
  expireSession,
  followSessionOwner,
  requestSessionCheck,
  sessionEpoch,
  sessionLapsed,
  setSessionOwner,
  startOver,
  trackUnsaved,
} from '../sessionWork';

const { me, login, register, logout } = vi.hoisted(() => ({
  me: vi.fn<() => Promise<{ user: User | null }>>(),
  login: vi.fn<(body: Credentials) => Promise<{ user: User }>>(),
  register: vi.fn<(body: Registration) => Promise<{ user: User }>>(),
  logout: vi.fn<() => Promise<void>>(),
}));
vi.mock('../../api/endpoints', () => ({ authApi: { me, login, register, logout } }));

const mogae: User = { id: 'u1', username: 'mogae', displayName: '모개', role: 'user' };
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('세션 확인', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    me.mockReset();
  });

  it('서버가 누구인지 알려 주면 그대로 알린다', async () => {
    const answer = vi.fn();
    followSession(async () => ({ user: mogae }), answer);
    await flush();
    expect(answer).toHaveBeenCalledExactlyOnceWith(mogae);
  });

  it('로그인한 사람이 없다고 하면 없는 것이다', async () => {
    const answer = vi.fn();
    followSession(async () => ({ user: null }), answer);
    await flush();
    expect(answer).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('401만 로그아웃으로 본다', async () => {
    const answer = vi.fn();
    followSession(() => Promise.reject(new ApiRequestError(401, 'login_required', '')), answer);
    await flush();
    expect(answer).toHaveBeenCalledExactlyOnceWith(null);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it('연결이 끊기거나 서버가 탈이 나면 로그아웃으로 보지 않고, 점점 늦춰 가며 다시 묻는다', async () => {
    const answer = vi.fn();
    const ask = vi.fn<() => Promise<{ user: User | null }>>();
    ask
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new ApiRequestError(503, 'database', ''))
      .mockRejectedValueOnce(new ApiTimeoutError(30_000));
    followSession(ask, answer);
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(answer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SESSION_RETRY_MS[0] - 1);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ask).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(SESSION_RETRY_MS[1]);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(answer).not.toHaveBeenCalled();

    ask.mockResolvedValueOnce({ user: mogae });
    await vi.advanceTimersByTimeAsync(SESSION_RETRY_MS[2]);
    expect(ask).toHaveBeenCalledTimes(4);
    expect(answer).toHaveBeenCalledExactlyOnceWith(mogae);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(ask).toHaveBeenCalledTimes(4);
  });

  it('오래 안 되면 마지막 간격으로 계속 묻는다', async () => {
    const ask = vi.fn<() => Promise<{ user: User | null }>>().mockRejectedValue(new TypeError('Failed to fetch'));
    followSession(ask, vi.fn());
    await vi.advanceTimersByTimeAsync(SESSION_RETRY_MS.reduce((sum, ms) => sum + ms, 0));
    expect(ask).toHaveBeenCalledTimes(SESSION_RETRY_MS.length + 1);
    const last = SESSION_RETRY_MS[SESSION_RETRY_MS.length - 1]!;
    await vi.advanceTimersByTimeAsync(last * 3);
    expect(ask).toHaveBeenCalledTimes(SESSION_RETRY_MS.length + 4);
  });

  it('실패할 때마다 몇 번째 실패인지 알린다', async () => {
    const failed = vi.fn();
    const ask = vi
      .fn<() => Promise<{ user: User | null }>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new ApiRequestError(503, 'database', ''))
      .mockResolvedValueOnce({ user: mogae });
    followSession(ask, vi.fn(), [10], failed);
    await flush();
    expect(failed).toHaveBeenLastCalledWith(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(failed).toHaveBeenLastCalledWith(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(failed).toHaveBeenCalledTimes(2);
  });

  it('멈추면 기다리던 질문도 늦게 온 대답도 버린다', async () => {
    const answer = vi.fn();
    const ask = vi.fn<() => Promise<{ user: User | null }>>().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const stop = followSession(ask, answer);
    await flush();
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    let late!: (result: { user: User | null }) => void;
    const slow = followSession(() => new Promise((done) => (late = done)), answer);
    slow();
    late({ user: mogae });
    await flush();
    expect(answer).not.toHaveBeenCalled();
  });
});

describe('로그인 상태 제공자', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', FakeChannel);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeChannel.open.clear();
    me.mockReset();
    login.mockReset(); register.mockReset(); logout.mockReset(); setSessionOwner(null);
  });
  const Probe = () => {
    const { status, user } = useAuth();
    return <p>{`${status}:${user?.username ?? '-'}`}</p>;
  };
  const shown = (container: HTMLElement) => container.querySelector('p')?.textContent;
  let auth!: ReturnType<typeof useAuth>;
  const Actions = () => { auth = useAuth(); return <Probe />; };

  it('서버가 응답하지 않는 동안은 로그아웃(anonymous)이 아니라 불러오는 중으로 두고, 응답하면 로그인 상태가 된다', async () => {
    me.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new ApiRequestError(502, 'http_error', ''))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { container, unmount } = await mount(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(shown(container)).toBe('loading:-');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_RETRY_MS[0] + SESSION_RETRY_MS[1]);
    });
    expect(me).toHaveBeenCalledTimes(3);
    expect(shown(container)).toBe('loading:-');

    me.mockResolvedValueOnce({ user: mogae });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_RETRY_MS[2]);
    });
    expect(shown(container)).toBe('signedIn:mogae');
    await unmount();
  });

  it('화면이 다시 보이면 누가 로그인했는지 묻고(포커스와 함께 와도 한 번), 보이는 채로 둔 화면은 반나절마다 물어 세션을 늘린다', async () => {
    const visibility = (state: DocumentVisibilityState) => Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    visibility('visible');
    me.mockResolvedValue({ user: mogae });
    const { container, unmount } = await mount(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(me).toHaveBeenCalledTimes(1);
    // Coming back to the tab: focus and visibilitychange arrive together, and ask once.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
    });
    expect(me).toHaveBeenCalledTimes(2);
    // A hidden page does not ask, on its own or as it is hidden.
    visibility('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(2 * SESSION_RENEW_MS);
    });
    expect(me).toHaveBeenCalledTimes(2);
    visibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
    });
    expect(me).toHaveBeenCalledTimes(3);
    // Left in view, it asks on its own once the half day since the last ask is up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_RENEW_MS - SESSION_RENEW_MS / 12);
    });
    expect(me).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_RENEW_MS / 6);
    });
    expect(me).toHaveBeenCalledTimes(4);
    expect(shown(container)).toBe('signedIn:mogae');
    await unmount();
    await vi.advanceTimersByTimeAsync(2 * SESSION_RENEW_MS);
    expect(me).toHaveBeenCalledTimes(4);
  });

  it('서버가 로그인한 사람이 없다고 하면 바로 anonymous다', async () => {
    me.mockResolvedValueOnce({ user: null });
    const { container, unmount } = await mount(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(shown(container)).toBe('anonymous:-');
    await unmount();
  });

  it('화면이 닫히면 다시 묻지 않는다', async () => {
    me.mockRejectedValue(new TypeError('Failed to fetch'));
    const { unmount } = await mount(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await unmount();
    const asked = me.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(me).toHaveBeenCalledTimes(asked);
  });

  it('최초 me의 늦은 응답은 새 로그인 계정을 덮지 않는다', async () => {
    let answer!: (value: { user: User | null }) => void;
    me.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const other = { ...mogae, id: 'u2', username: 'other' };
    login.mockResolvedValueOnce({ user: other });
    const { container, unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
    await act(async () => { await auth.login({ username: 'other', password: 'password' }); });
    answer({ user: mogae });
    await act(flush);
    expect(shown(container)).toBe('signedIn:other');
    await unmount();
  });

  it('로그아웃에 실패하면 로그인 상태와 이전 세션 작업을 유지하고 오류를 반환한다', async () => {
    me.mockResolvedValueOnce({ user: mogae });
    logout.mockRejectedValueOnce(new TypeError('offline'));
    const { container, unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
    const stop = vi.fn(); const unwatch = followSessionOwner(mogae.id, stop);
    await act(async () => { await expect(auth.logout()).rejects.toThrow('offline'); });
    expect(shown(container)).toBe('signedIn:mogae'); expect(stop).not.toHaveBeenCalled();
    unwatch(); await unmount();
  });

  it('로그아웃 성공 시 이전 계정의 백그라운드 작업을 로그인 화면보다 먼저 취소한다', async () => {
    me.mockResolvedValueOnce({ user: mogae }); logout.mockResolvedValueOnce(undefined);
    const { container, unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
    const stop = vi.fn(); followSessionOwner(mogae.id, stop);
    await act(async () => { await auth.logout(); });
    expect(stop).toHaveBeenCalledTimes(1); expect(shown(container)).toBe('anonymous:-');
    await unmount();
  });

  it('로그아웃하면 이 브라우저에 남은 그 계정의 초안을 지운다', async () => {
    me.mockResolvedValueOnce({ user: mogae }); logout.mockResolvedValueOnce(undefined);
    const { unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
    localStorage.setItem(draftKey(mogae.id, 'status'), JSON.stringify({ text: '쓰다 만 글', base: '' }));
    localStorage.setItem('mogaesup.theme', 'dark');
    await act(async () => { await auth.logout(); });
    expect(localStorage.getItem(draftKey(mogae.id, 'status'))).toBeNull();
    expect(localStorage.getItem('mogaesup.theme')).toBe('dark');
    localStorage.clear();
    await unmount();
  });

  describe('세션이 풀렸을 때', () => {
    const visible = () => Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    beforeEach(visible);

    it('로그아웃 상태가 되지만, 그 계정의 작업은 멈추지 않고 다시 로그인하면 이어진다', async () => {
      me.mockResolvedValueOnce({ user: mogae });
      const { container, unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      const stop = vi.fn(); const resume = vi.fn();
      const unwatch = followSessionOwner(mogae.id, stop, resume);
      await act(async () => { expireSession(); });
      expect(shown(container)).toBe('anonymous:-');
      expect(auth.lapsed).toEqual(mogae);
      expect(stop).not.toHaveBeenCalled();

      // Back on the tab it asks again; the server saying nobody is the lapse itself and stops nothing.
      me.mockResolvedValueOnce({ user: null });
      await act(async () => { window.dispatchEvent(new Event('focus')); await flush(); });
      expect(me).toHaveBeenCalledTimes(2);
      expect(stop).not.toHaveBeenCalled();
      expect(auth.lapsed).toEqual(mogae);

      login.mockResolvedValueOnce({ user: mogae });
      await act(async () => { await auth.login({ username: 'mogae', password: 'password' }); });
      expect(resume).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(shown(container)).toBe('signedIn:mogae');
      expect(auth.lapsed).toBeNull();
      unwatch(); await unmount();
    });

    it('다른 탭에서 다시 로그인했다면 이 탭으로 돌아올 때 알아채고 작업을 잇는다', async () => {
      me.mockResolvedValueOnce({ user: mogae });
      const { container, unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      const resume = vi.fn();
      const unwatch = followSessionOwner(mogae.id, vi.fn(), resume);
      await act(async () => { expireSession(); });
      me.mockResolvedValueOnce({ user: mogae });
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await flush(); });
      expect(shown(container)).toBe('signedIn:mogae');
      expect(resume).toHaveBeenCalledTimes(1);
      unwatch(); await unmount();
    });

    it('다른 사람이 로그인하면 이전 계정의 작업을 멈추고 초안을 지운다', async () => {
      me.mockResolvedValueOnce({ user: mogae });
      const { unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      const stop = vi.fn(); const resume = vi.fn();
      followSessionOwner(mogae.id, stop, resume);
      localStorage.setItem(draftKey(mogae.id, 'title'), JSON.stringify({ text: '초안', base: '' }));
      await act(async () => { expireSession(); });
      login.mockResolvedValueOnce({ user: { ...mogae, id: 'u2', username: 'other' } });
      await act(async () => { await auth.login({ username: 'other', password: 'password' }); });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(resume).not.toHaveBeenCalled();
      expect(localStorage.getItem(draftKey(mogae.id, 'title'))).toBeNull();
      await unmount();
    });

    it('로그인하는 동안 돌아온 탭이 물은 me의 답은 로그인 결과를 덮지 않는다', async () => {
      me.mockResolvedValueOnce({ user: mogae });
      const { container, unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      await act(async () => { expireSession(); });
      // The sign-in is on its way when the tab comes back into view.
      let signedIn!: (value: { user: User }) => void;
      login.mockImplementationOnce(() => new Promise((resolve) => { signedIn = resolve; }));
      const other = { ...mogae, id: 'u2', username: 'other' };
      let answer!: (value: { user: User | null }) => void;
      me.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
      let done!: Promise<User>;
      await act(async () => { done = auth.login({ username: 'other', password: 'password' }); });
      await act(async () => { window.dispatchEvent(new Event('focus')); await flush(); });
      await act(async () => { signedIn({ user: other }); await done; });
      answer?.({ user: null });
      await act(flush);
      expect(shown(container)).toBe('signedIn:other');
      me.mockReset();
      await unmount();
    });

    it('풀린 세션으로 새로고침한 뒤 다른 사람이 로그인해도 이전 계정의 초안을 지운다', async () => {
      // After the reload the server knows nobody, and this page never knew who left the drafts.
      localStorage.setItem(draftKey(mogae.id, 'title'), JSON.stringify({ text: '초안', base: '' }));
      localStorage.setItem('mogaesup:layout-interpretations:u1', '[]');
      localStorage.setItem(draftKey('u2', 'status'), JSON.stringify({ text: '내 초안', base: '' }));
      me.mockResolvedValueOnce({ user: null });
      const { container, unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      expect(shown(container)).toBe('anonymous:-');
      expect(localStorage.getItem(draftKey(mogae.id, 'title'))).not.toBeNull();
      login.mockResolvedValueOnce({ user: { ...mogae, id: 'u2', username: 'other' } });
      await act(async () => { await auth.login({ username: 'other', password: 'password' }); });
      expect(localStorage.getItem(draftKey(mogae.id, 'title'))).toBeNull();
      expect(localStorage.getItem('mogaesup:layout-interpretations:u1')).toBeNull();
      expect(localStorage.getItem(draftKey('u2', 'status'))).not.toBeNull();
      localStorage.clear();
      await unmount();
    });

    it('아무도 로그인하지 않았거나 이미 풀린 세션에는 아무 일도 없다', () => {
      setSessionOwner(null);
      expireSession();
      expect(sessionLapsed()).toBe(false);
      setSessionOwner('u1');
      const sentAt = sessionEpoch();
      setSessionOwner('u1');
      expireSession(sentAt);
      expect(sessionLapsed()).toBe(false);
      expireSession();
      expect(sessionLapsed()).toBe(true);
    });
  });

  describe('다른 탭에서 계정이 바뀌었을 때', () => {
    const visible = () => Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    beforeEach(visible);
    const other: User = { ...mogae, id: 'u2', username: 'other' };

    it('다른 탭이 로그인을 알리면 바로 다시 묻고 그 계정으로 바뀌며, 이전 계정의 작업은 멈춘다', async () => {
      me.mockResolvedValueOnce({ user: mogae });
      const { container, unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      const stop = vi.fn();
      followSessionOwner(mogae.id, stop);
      const otherTab = new FakeChannel(SESSION_CHANNEL);
      me.mockResolvedValueOnce({ user: other });
      await act(async () => { otherTab.postMessage({ userId: other.id }); await flush(); });
      expect(me).toHaveBeenCalledTimes(2);
      expect(shown(container)).toBe('signedIn:other');
      expect(stop).toHaveBeenCalledTimes(1);
      otherTab.close();
      await unmount();
    });

    it('다른 탭에서 로그아웃했다면 돌아올 때 세션이 풀린 것으로 보고 작업을 남기며, 다시 로그인하면 잇는다', async () => {
      me.mockResolvedValueOnce({ user: mogae });
      const { container, unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      const stop = vi.fn(); const resume = vi.fn();
      const unwatch = followSessionOwner(mogae.id, stop, resume);
      me.mockResolvedValueOnce({ user: null });
      await act(async () => { window.dispatchEvent(new Event('focus')); await flush(); });
      expect(shown(container)).toBe('anonymous:-');
      expect(auth.lapsed).toEqual(mogae);
      expect(sessionLapsed()).toBe(true);
      expect(stop).not.toHaveBeenCalled();

      login.mockResolvedValueOnce({ user: mogae });
      await act(async () => { await auth.login({ username: 'mogae', password: 'password' }); });
      expect(resume).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      unwatch();
      await unmount();
    });

    it('같은 계정이면 아무것도 바꾸지 않고, 서버가 새로 알려 준 권한만 받는다', async () => {
      me.mockResolvedValueOnce({ user: mogae });
      const { unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      const stop = vi.fn(); const resume = vi.fn();
      const unwatch = followSessionOwner(mogae.id, stop, resume);
      const before = auth.user;
      me.mockResolvedValueOnce({ user: { ...mogae } });
      await act(async () => { window.dispatchEvent(new Event('focus')); await flush(); });
      expect(auth.user).toBe(before);
      me.mockResolvedValueOnce({ user: { ...mogae, permissions: ['operator'] } });
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await flush(); });
      expect(auth.user?.permissions).toEqual(['operator']);
      expect(stop).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      unwatch();
      await unmount();
    });

    it('다른 계정에게 간 답(실시간 티켓)이 다시 묻게 한다', async () => {
      me.mockResolvedValueOnce({ user: mogae });
      const { container, unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      me.mockResolvedValueOnce({ user: other });
      await act(async () => { requestSessionCheck(); await flush(); });
      expect(me).toHaveBeenCalledTimes(2);
      expect(shown(container)).toBe('signedIn:other');
      await unmount();
      // A page that is gone asks nothing.
      requestSessionCheck();
      expect(me).toHaveBeenCalledTimes(2);
    });

    it('다른 탭이 다른 계정으로 로그인해도 이 탭에 저장하지 못한 편집이 있으면 버리지 않고 세션이 풀린 채로 두며, 다시 로그인하면 잇는다', async () => {
      me.mockResolvedValueOnce({ user: mogae });
      const { container, unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      const stop = vi.fn(); const resume = vi.fn();
      const unwatch = followSessionOwner(mogae.id, stop, resume);
      const untrack = trackUnsaved(() => true);
      const otherTab = new FakeChannel(SESSION_CHANNEL);
      me.mockResolvedValueOnce({ user: other });
      await act(async () => { otherTab.postMessage({ userId: other.id }); await flush(); });
      expect(shown(container)).toBe('anonymous:-');
      expect(auth.lapsed).toEqual(mogae);
      expect(stop).not.toHaveBeenCalled();
      // Coming back to the tab asks again; the edits still wait for their member.
      me.mockResolvedValueOnce({ user: other });
      await act(async () => { window.dispatchEvent(new Event('focus')); await flush(); });
      expect(auth.lapsed).toEqual(mogae);
      expect(stop).not.toHaveBeenCalled();

      login.mockResolvedValueOnce({ user: mogae });
      await act(async () => { await auth.login({ username: 'mogae', password: 'password' }); });
      expect(resume).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(shown(container)).toBe('signedIn:mogae');
      untrack(); unwatch(); otherTab.close();
      await unmount();
    });

    it('기다리던 편집이 저장되거나 정리되면 다음에 물을 때 다른 탭의 계정을 따른다', async () => {
      me.mockResolvedValueOnce({ user: mogae });
      const { container, unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      const stop = vi.fn();
      followSessionOwner(mogae.id, stop);
      let unsaved = true;
      const untrack = trackUnsaved(() => unsaved);
      me.mockResolvedValueOnce({ user: other });
      await act(async () => { requestSessionCheck(); await flush(); });
      expect(auth.lapsed).toEqual(mogae);
      unsaved = false;
      me.mockResolvedValueOnce({ user: other });
      await act(async () => { window.dispatchEvent(new Event('focus')); await flush(); });
      expect(shown(container)).toBe('signedIn:other');
      expect(stop).toHaveBeenCalledTimes(1);
      untrack();
      await unmount();
    });

    it('이 탭에서 세션을 새로 열면(비밀번호 바꾸기, 다른 기기 로그아웃) 다른 탭에 알린다', async () => {
      const otherTab = new FakeChannel(SESSION_CHANNEL);
      const heard = vi.fn();
      otherTab.onmessage = (event) => heard(event.data);
      me.mockResolvedValueOnce({ user: mogae });
      const { unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      startOver()('renewed');
      expect(heard).toHaveBeenCalledExactlyOnceWith({ userId: mogae.id, renewed: true });
      // A change that brought no new cookie (a wrong password) tells nobody.
      startOver()();
      expect(heard).toHaveBeenCalledTimes(1);
      otherTab.close();
      await unmount();
    });

    it('다른 탭이 세션을 새로 열었다고 알리면 옛 쿠키에 대한 늦은 거절은 흘려듣고, 그 사이 풀린 세션은 되찾아 작업을 잇는다', async () => {
      me.mockResolvedValueOnce({ user: mogae });
      const { container, unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      const stop = vi.fn(); const resume = vi.fn();
      const unwatch = followSessionOwner(mogae.id, stop, resume);
      const otherTab = new FakeChannel(SESSION_CHANNEL);
      // Sent with the old cookie before the news; refused after it.
      const sentAt = sessionEpoch();
      me.mockResolvedValueOnce({ user: mogae });
      await act(async () => { otherTab.postMessage({ userId: mogae.id, renewed: true }); await flush(); });
      expect(me).toHaveBeenCalledTimes(2);
      await act(async () => { expireSession(sentAt); });
      expect(shown(container)).toBe('signedIn:mogae');
      expect(resume).toHaveBeenCalledTimes(1);

      // Refused before the news came: the tab lapsed for a moment, and the news brings the member back.
      await act(async () => { expireSession(); });
      expect(shown(container)).toBe('anonymous:-');
      me.mockResolvedValueOnce({ user: mogae });
      await act(async () => { otherTab.postMessage({ userId: mogae.id, renewed: true }); await flush(); });
      expect(shown(container)).toBe('signedIn:mogae');
      expect(resume).toHaveBeenCalledTimes(2);
      expect(stop).not.toHaveBeenCalled();
      unwatch(); otherTab.close();
      await unmount();
    });

    it('세션을 새로 여는 사이에 물은 me가 옛 쿠키로 아무도 아니라고 답해도 세션을 풀지 않는다', async () => {
      me.mockResolvedValueOnce({ user: mogae });
      const { container, unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      let answer!: (value: { user: User | null }) => void;
      me.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
      await act(async () => { window.dispatchEvent(new Event('focus')); await flush(); });
      expect(me).toHaveBeenCalledTimes(2);
      startOver()('renewed');
      await act(async () => { answer({ user: null }); await flush(); });
      expect(shown(container)).toBe('signedIn:mogae');
      expect(sessionLapsed()).toBe(false);
      await unmount();
    });

    it('이 탭이 로그인하는 사이 다른 탭이 로그인을 알리면, 끝난 뒤 다시 물어 쿠키의 주인을 따른다', async () => {
      me.mockResolvedValueOnce({ user: null });
      const { container, unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      let signedIn!: (value: { user: User }) => void;
      login.mockImplementationOnce(() => new Promise((resolve) => { signedIn = resolve; }));
      let done!: Promise<User>;
      await act(async () => { done = auth.login({ username: 'mogae', password: 'password' }); });
      const otherTab = new FakeChannel(SESSION_CHANNEL);
      await act(async () => { otherTab.postMessage({ userId: other.id }); await flush(); });
      expect(me).toHaveBeenCalledTimes(1);
      // The other tab's sign-in reached the cookie last.
      me.mockResolvedValueOnce({ user: other });
      await act(async () => { signedIn({ user: mogae }); await done; await flush(); });
      expect(me).toHaveBeenCalledTimes(2);
      expect(shown(container)).toBe('signedIn:other');
      otherTab.close();
      await unmount();
    });

    it('이 탭에서 로그인하거나 로그아웃하면 다른 탭에 알린다', async () => {
      const otherTab = new FakeChannel(SESSION_CHANNEL);
      const heard = vi.fn();
      otherTab.onmessage = (event) => heard(event.data);
      me.mockResolvedValueOnce({ user: null });
      const { unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      login.mockResolvedValueOnce({ user: mogae });
      await act(async () => { await auth.login({ username: 'mogae', password: 'password' }); });
      expect(heard).toHaveBeenLastCalledWith({ userId: mogae.id });
      logout.mockResolvedValueOnce(undefined);
      await act(async () => { await auth.logout(); });
      expect(heard).toHaveBeenLastCalledWith({ userId: null });
      expect(heard).toHaveBeenCalledTimes(2);
      await unmount();
      expect(FakeChannel.open.size).toBe(1);
      otherTab.close();
    });
  });

  describe('서버에 닿지 않을 때', () => {
    it('몇 번 연달아 실패하면 서버에 연결하지 못했다고 보이고, 다시 시도하면 바로 다시 묻는다', async () => {
      me.mockRejectedValue(new TypeError('Failed to fetch'));
      const { container, unmount } = await mount(<AuthProvider><Loading /></AuthProvider>);
      expect(container.textContent).toContain('불러오는 중');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SESSION_RETRY_MS[0] + SESSION_RETRY_MS[1]);
      });
      expect(me).toHaveBeenCalledTimes(SESSION_UNREACHABLE_AFTER);
      expect(container.querySelector('[role=alert]')?.textContent).toContain('서버에 연결하지 못했어요');

      me.mockReset();
      me.mockResolvedValueOnce({ user: null });
      const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === '다시 시도')!;
      await act(async () => { retry.click(); await flush(); });
      expect(me).toHaveBeenCalledTimes(1);
      await unmount();
    });

    it('늦게라도 대답이 오면 기다리던 화면이 그대로 이어진다', async () => {
      me.mockRejectedValueOnce(new TypeError('a')).mockRejectedValueOnce(new TypeError('b')).mockRejectedValueOnce(new TypeError('c'));
      const { container, unmount } = await mount(<AuthProvider><Actions /></AuthProvider>);
      await act(async () => { await vi.advanceTimersByTimeAsync(SESSION_RETRY_MS[0] + SESSION_RETRY_MS[1]); });
      expect(auth.unreachable).toBe(true);
      me.mockResolvedValueOnce({ user: mogae });
      await act(async () => { await vi.advanceTimersByTimeAsync(SESSION_RETRY_MS[2]); });
      expect(auth.unreachable).toBe(false);
      expect(shown(container)).toBe('signedIn:mogae');
      await unmount();
    });
  });
});
