import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError, ApiTimeoutError } from '../../api/client';
import type { Credentials, Registration, User } from '../../api/types';
import { mount } from '../../__tests__/mount';
import { AuthProvider, useAuth } from '../AuthProvider';
import { followSession, SESSION_RETRY_MS } from '../session';
import { followSessionOwner, setSessionOwner } from '../sessionWork';

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
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
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
});
