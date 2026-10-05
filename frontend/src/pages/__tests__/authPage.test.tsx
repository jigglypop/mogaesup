import { act } from 'react';

import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Credentials, Registration, User } from '../../api/types';
import { mount, type } from '../../__tests__/mount';
import { AuthProvider } from '../../auth/AuthProvider';
import { setSessionOwner } from '../../auth/sessionWork';
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
