import { act } from 'react';

import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials, Registration, User } from '../../api/types';
import { FakeChannel } from '../../__tests__/broadcast';
import { mount, type } from '../../__tests__/mount';
import { AuthProvider } from '../../auth/AuthProvider';
import { expireSession, setSessionOwner, trackUnsaved } from '../../auth/sessionWork';
import { AuthPage } from '../AuthPage';

const { me, login, register, logout } = vi.hoisted(() => ({
  me: vi.fn<() => Promise<{ user: User | null }>>(),
  login: vi.fn<(body: Credentials) => Promise<{ user: User }>>(),
  register: vi.fn<(body: Registration) => Promise<{ user: User }>>(),
  logout: vi.fn<() => Promise<void>>(),
}));
vi.mock('../../api/endpoints', () => ({ authApi: { me, login, register, logout } }));

const mogae: User = { id: 'u1', username: 'mogae', displayName: '모개', role: 'user' };

function Where() {
  const { pathname, search } = useLocation();
  return <p className="where">{`${pathname}${search}`}</p>;
}

const open = (entry: string) =>
  mount(
    <AuthProvider>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/" element={<AuthPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
const where = (container: HTMLElement) => container.querySelector('.where')?.textContent;

beforeEach(() => vi.stubGlobal('BroadcastChannel', FakeChannel));
afterEach(() => {
  vi.unstubAllGlobals();
  FakeChannel.open.clear();
});

describe('로그인 화면에서 돌아가는 곳', () => {
  afterEach(() => {
    me.mockReset();
    login.mockReset();
    setSessionOwner(null);
  });

  it('로그인하면 로그인 링크가 실어 온 next로 돌아간다', async () => {
    me.mockResolvedValueOnce({ user: null });
    login.mockResolvedValueOnce({ user: mogae });
    const { container, unmount } = await open(`/?next=${encodeURIComponent('/@mogae/edit')}`);
    await type(container.querySelector<HTMLInputElement>('input[name=username]')!, 'mogae');
    await type(container.querySelector<HTMLInputElement>('input[name=password]')!, 'password');
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(login).toHaveBeenCalledWith({ username: 'mogae', password: 'password' });
    expect(where(container)).toBe('/@mogae/edit');
    await unmount();
  });

  it('이미 로그인한 방문자는 next로 바로 간다', async () => {
    me.mockResolvedValueOnce({ user: mogae });
    const { container, unmount } = await open(`/?next=${encodeURIComponent('/character?look=1')}`);
    expect(where(container)).toBe('/character?look=1');
    await unmount();
  });

  it('next가 없거나 다른 사이트를 가리키면 내 섬으로 간다', async () => {
    // Including paths that only become another site once normalized: before, these threw inside <Navigate>.
    const away = ['https://evil.example/', '//evil.example', '/.//evil.example', '/%2e//evil.example', '/x/..//evil.example/a'];
    for (const entry of ['/', ...away.map((next) => `/?next=${encodeURIComponent(next)}`)]) {
      me.mockResolvedValueOnce({ user: mogae });
      const { container, unmount } = await open(entry);
      expect(where(container)).toBe('/@mogae');
      await unmount();
    }
  });
});

describe('세션이 풀린 계정의 저장하지 못한 편집', () => {
  let go!: (to: string) => void;
  function Go() {
    go = useNavigate();
    return null;
  }
  /** Signed in on the island, then the session lapses and the member goes to sign in again in the same page. */
  const lapsedAtSignIn = async () => {
    me.mockResolvedValueOnce({ user: mogae });
    const view = await mount(
      <AuthProvider>
        <MemoryRouter initialEntries={['/@mogae']}>
          <Go />
          <Routes>
            <Route path="/" element={<AuthPage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
    await act(async () => { expireSession(); });
    await act(async () => go('/'));
    return view;
  };
  const submit = async (container: HTMLElement, username: string) => {
    await type(container.querySelector<HTMLInputElement>('input[name=username]')!, username);
    await type(container.querySelector<HTMLInputElement>('input[name=password]')!, 'password');
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  };

  afterEach(() => {
    me.mockReset();
    login.mockReset();
    register.mockReset();
    setSessionOwner(null);
    vi.restoreAllMocks();
  });

  it('다른 계정으로 로그인하면 사라지므로 먼저 묻고, 그만두면 로그인하지 않는다', async () => {
    const { container, unmount } = await lapsedAtSignIn();
    const untrack = trackUnsaved(() => true);
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await submit(container, 'other');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();

    login.mockResolvedValueOnce({ user: { ...mogae, id: 'u2', username: 'other' } });
    await submit(container, 'other');
    expect(ask).toHaveBeenCalledTimes(2);
    expect(login).toHaveBeenCalledWith({ username: 'other', password: 'password' });
    expect(where(container)).toBe('/@other');
    untrack();
    await unmount();
  });

  it('같은 계정으로 다시 로그인하거나 남은 편집이 없으면 묻지 않는다', async () => {
    const ask = vi.spyOn(window, 'confirm');
    const first = await lapsedAtSignIn();
    const untrack = trackUnsaved(() => true);
    login.mockResolvedValueOnce({ user: mogae });
    await submit(first.container, 'Mogae');
    expect(login).toHaveBeenCalledWith({ username: 'mogae', password: 'password' });
    untrack();
    await first.unmount();

    const second = await lapsedAtSignIn();
    login.mockResolvedValueOnce({ user: { ...mogae, id: 'u2', username: 'other' } });
    await submit(second.container, 'other');
    expect(login).toHaveBeenCalledTimes(2);
    expect(ask).not.toHaveBeenCalled();
    await second.unmount();
  });
});
