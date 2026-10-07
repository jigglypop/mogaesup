import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { User } from '../../api/types';
import { mount } from '../../__tests__/mount';

const catalog = vi.hoisted(() => ({
  adminItems: vi.fn(async () => ({ items: [] })),
  factoryCharacters: vi.fn(async () => ({ characters: [] })),
  imports: vi.fn(async () => ({ imports: [] })),
}));
vi.mock('../../api/endpoints', () => ({ catalogApi: catalog }));
const auth = vi.hoisted(() => ({ status: 'signedIn', user: null as User | null }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => auth }));

import { AdminPage } from '../AdminPage';

const member: User = { id: 'u1', username: 'mogae', displayName: '모개', role: 'user' };

function Where() {
  const { pathname } = useLocation();
  return <p className="where">{pathname}</p>;
}

const open = (entry: string) =>
  mount(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/admin/studio/*" element={<Where />} />
        <Route path="/admin/*" element={<AdminPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

afterEach(() => vi.clearAllMocks());

describe('/admin에 들어올 수 있는 사람', () => {
  it('카탈로그를 편집하지 않는 운영자(유료 운영자 포함)는 캐릭터 공장으로 보낸다', async () => {
    for (const permissions of [['operator'], ['paid_operator', 'operator']] as const) {
      auth.user = { ...member, permissions: [...permissions] };
      for (const entry of ['/admin', '/admin/catalog']) {
        const { container, unmount } = await open(entry);
        expect(container.querySelector('.where')?.textContent).toBe('/admin/studio');
        await unmount();
      }
    }
    expect(catalog.adminItems).not.toHaveBeenCalled();
  });

  it('운영 권한이 없는 회원은 자기 섬으로 보낸다', async () => {
    auth.user = { ...member, permissions: ['moderator'] };
    const { container, unmount } = await open('/admin');
    expect(container.querySelector('.where')?.textContent).toBe('/@mogae');
    await unmount();
  });
});
