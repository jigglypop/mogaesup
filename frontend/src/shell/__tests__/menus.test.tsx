import { act } from 'react';

import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { User } from '../../api/types';
import { mount, type } from '../../__tests__/mount';
import { PageShell } from '../Shell';

vi.mock('../../api/endpoints', () => ({
  socialApi: { requests: vi.fn(async () => ({ received: [], sent: [] })), accept: vi.fn(), dismiss: vi.fn(), dismissAll: vi.fn() },
  authApi: { changePassword: vi.fn(), logoutOthers: vi.fn() },
}));
const auth = vi.hoisted(() => ({ user: null as User | null, lapsed: null as User | null, logout: vi.fn() }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => auth }));

const admin: User = { id: 'u1', username: 'mogae', displayName: '모개', role: 'admin', permissions: ['admin', 'paid_operator', 'operator', 'moderator', 'catalog_editor', 'studio_viewer'] };

function Where() {
  const { pathname, search } = useLocation();
  return <output>{pathname + search}</output>;
}
const page = (path = '/explore') => (
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route
        path="*"
        element={
          <PageShell title="둘러보기">
            <p className="body">본문</p>
          </PageShell>
        }
      />
    </Routes>
    <Where />
  </MemoryRouter>
);
const hrefs = (root: ParentNode) => [...root.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'));

describe('앱의 메뉴', () => {
  beforeEach(() => {
    auth.user = admin;
  });
  afterEach(() => {
    auth.user = null;
    vi.clearAllMocks();
  });

  it('페이지에는 레일이 없고, 머리띠에는 처음으로 가는 상표와 제목, 찾기, 알림과 내 메뉴만 있다', async () => {
    const { container, unmount } = await mount(page());
    expect(container.querySelector('.mg-rail, nav[aria-label="모개숲"]')).toBeNull();
    expect(container.querySelector('.mg-topbar .mg-brand')?.getAttribute('href')).toBe('/@mogae');
    expect(container.querySelector('.mg-topbar .mg-pill')?.textContent).toBe('둘러보기');
    expect(container.querySelector('.mg-topbar [role=search]')).not.toBeNull();
    expect(container.querySelector('.mg-page-main .body')?.textContent).toBe('본문');
    // 운영·캐릭터·둘러보기로 가는 길은 어디에도 없다.
    expect(hrefs(container)).toEqual(['/@mogae']);
    await unmount();
  });

  it('내 메뉴에는 내 집과 화면 밝기, 비밀번호와 로그아웃이 있고 내 캐릭터는 없다', async () => {
    const { container, unmount } = await mount(page());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="내 메뉴"]')!.click());
    const items = [...container.querySelectorAll('[role=menu] > a, [role=menu] > button')].map((item) => item.textContent?.trim());
    expect(items).toEqual(['내 집', '비밀번호 바꾸기', '다른 기기에서 모두 로그아웃', '로그아웃']);
    expect([...container.querySelectorAll('[role=menuitemradio]')].map((item) => item.textContent)).toEqual(['밝게', '어둡게', '기기 설정']);
    expect(hrefs(container.querySelector('[role=menu]')!)).toEqual(['/@mogae']);
    await unmount();
  });

  it('로그인하지 않으면 상표는 들어가는 곳으로 가고, 머리띠에는 로그인이 있다', async () => {
    auth.user = null;
    const { container, unmount } = await mount(page('/explore?q=x'));
    expect(container.querySelector('.mg-rail')).toBeNull();
    expect(hrefs(container)).toEqual(['/', `/?next=${encodeURIComponent('/explore?q=x')}`]);
    await unmount();
  });

  it('찾기는 그 결과로 간다', async () => {
    const { container, unmount } = await mount(page('/@mogae'));
    await type(container.querySelector<HTMLInputElement>('[role=search] input')!, ' 모개 ');
    await act(async () => container.querySelector<HTMLFormElement>('[role=search]')!.requestSubmit());
    expect(container.querySelector('output')?.textContent).toBe(`/explore?q=${encodeURIComponent('모개')}`);
    await unmount();
  });

  it('휴대폰의 찾기 단추는 상자를 열어 키보드를 받고, Esc나 닫기를 누르거나 다른 곳으로 떠나면 적은 글을 둔 채 접힌다', async () => {
    const { container, unmount } = await mount(page('/@mogae'));
    const opener = container.querySelector<HTMLButtonElement>('.mg-topbar .mg-search-open')!;
    const box = container.querySelector<HTMLFormElement>('.mg-topbar [role=search]')!;
    const field = box.querySelector('input')!;
    const isOpen = () => box.classList.contains('is-open');
    expect(opener.getAttribute('aria-label')).toBe('섬이나 사람 찾기');
    expect(opener.getAttribute('aria-controls')).toBe(box.id);
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    expect(isOpen()).toBe(false);

    await act(async () => opener.click());
    expect(isOpen()).toBe(true);
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(field);
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);

    // 다른 곳으로 떠나면 접히고, 다시 열면 적어 둔 글이 그대로 있다. 상자 안의 닫기로 가는 것은 떠나는 것이 아니다.
    await act(async () => opener.click());
    await type(field, '모개');
    await act(async () => field.blur());
    expect(isOpen()).toBe(false);
    await act(async () => opener.click());
    expect(field.value).toBe('모개');
    const close = box.querySelector<HTMLButtonElement>('[aria-label="찾기 닫기"]')!;
    await act(async () => close.focus());
    expect(isOpen()).toBe(true);
    await act(async () => close.click());
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(field.value).toBe('모개');

    // 열린 상자에서 찾으면 결과로 가고 상자는 접힌다.
    await act(async () => opener.click());
    await act(async () => box.requestSubmit());
    expect(container.querySelector('output')?.textContent).toBe(`/explore?q=${encodeURIComponent('모개')}`);
    expect(isOpen()).toBe(false);
    await unmount();
  });
});
