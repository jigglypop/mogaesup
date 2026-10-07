import { act } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../api/client';
import type { User } from '../../api/types';
import { mount, type } from '../../__tests__/mount';
import { trackUnsaved } from '../../auth/sessionWork';
import { adminHome, Rail, TopActions } from '../Shell';

const api = vi.hoisted(() => ({
  requests: vi.fn(),
  changePassword: vi.fn(),
  logoutOthers: vi.fn(),
  dismissAll: vi.fn(),
}));
vi.mock('../../api/endpoints', () => ({
  socialApi: { requests: api.requests, accept: vi.fn(), dismiss: vi.fn(), dismissAll: api.dismissAll },
  authApi: { changePassword: api.changePassword, logoutOthers: api.logoutOthers },
}));
const mogae: User = { id: 'u1', username: 'mogae', displayName: '모개', role: 'user' };
const auth = vi.hoisted(() => ({ user: null as User | null, lapsed: null as User | null, logout: vi.fn() }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => auth }));

const shell = () => (
  <MemoryRouter>
    <TopActions search={false} />
  </MemoryRouter>
);
const button = (text: string) => [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);
const openMenu = (container: HTMLElement) => act(async () => container.querySelector<HTMLButtonElement>('[aria-label="내 메뉴"]')!.click());

beforeEach(() => {
  auth.user = mogae;
  auth.lapsed = null;
  auth.logout.mockReset().mockResolvedValue(undefined);
  api.requests.mockReset().mockResolvedValue({ received: [], sent: [] });
  api.changePassword.mockReset();
  api.logoutOthers.mockReset();
  api.dismissAll.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('비밀번호 바꾸기', () => {
  it('현재와 새 비밀번호를 보내고, 서버가 말한 문제를 그대로 보이며, 바뀌면 그렇다고 한다', async () => {
    const { container, unmount } = await mount(shell());
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="내 메뉴"]')!;
    await openMenu(container);
    await act(async () => button('비밀번호 바꾸기')!.click());
    const dialog = document.querySelector<HTMLElement>('[role=dialog][aria-modal=true]')!;
    expect(dialog.getAttribute('aria-labelledby')).toBe('mg-password-title');
    const [current, next, again] = [...dialog.querySelectorAll<HTMLInputElement>('input[type=password]')];
    expect(document.activeElement).toBe(current);
    expect(again?.closest('label')?.textContent).toBe('새 비밀번호 확인');

    // Too short never reaches the server.
    await type(current!, 'old-password');
    await type(next!, 'short');
    await type(again!, 'short');
    await act(async () => button('바꾸기')!.click());
    expect(api.changePassword).not.toHaveBeenCalled();
    expect(dialog.querySelector('[role=alert]')?.textContent).toBe('새 비밀번호는 10자 이상 128자 이하예요.');

    // A typo in either one never reaches the server: it would end every other session on a password nobody knows.
    await type(next!, 'a-new-password');
    await type(again!, 'a-new-pasword');
    await act(async () => button('바꾸기')!.click());
    expect(api.changePassword).not.toHaveBeenCalled();
    expect(dialog.querySelector('[role=alert]')?.textContent).toBe('새 비밀번호가 서로 달라요.');

    api.changePassword.mockRejectedValueOnce(new ApiRequestError(400, 'wrong_password', '현재 비밀번호가 맞지 않습니다.'));
    await type(again!, 'a-new-password');
    await act(async () => button('바꾸기')!.click());
    expect(api.changePassword).toHaveBeenCalledExactlyOnceWith({ currentPassword: 'old-password', newPassword: 'a-new-password' });
    expect(dialog.querySelector('[role=alert]')?.textContent).toBe('현재 비밀번호가 맞지 않습니다.');

    api.changePassword.mockResolvedValueOnce(undefined);
    await act(async () => button('바꾸기')!.click());
    expect(dialog.querySelector('[role=status]')?.textContent).toBe('비밀번호를 바꿨어요');
    expect(dialog.querySelector('input')).toBeNull();
    await act(async () => button('닫기')!.click());
    expect(document.querySelector('[role=dialog][aria-modal=true]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await unmount();
  });

  it('Esc로 닫는다', async () => {
    const { container, unmount } = await mount(shell());
    await openMenu(container);
    await act(async () => button('비밀번호 바꾸기')!.click());
    const dialog = document.querySelector<HTMLElement>('[role=dialog][aria-modal=true]')!;
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[role=dialog][aria-modal=true]')).toBeNull();
    expect(api.changePassword).not.toHaveBeenCalled();
    await unmount();
  });
});

describe('다른 기기에서 모두 로그아웃', () => {
  it('묻고 나서 끝내고, 끝낸 세션 수를 보인다', async () => {
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.logoutOthers.mockResolvedValueOnce({ ended: 3 });
    const { container, unmount } = await mount(shell());
    await openMenu(container);
    await act(async () => button('다른 기기에서 모두 로그아웃')!.click());
    expect(ask).toHaveBeenCalledExactlyOnceWith('다른 기기에서 모두 로그아웃할까요?');
    expect(api.logoutOthers).toHaveBeenCalledOnce();
    expect(container.querySelector('[role=status]')?.textContent).toBe('다른 기기 3곳에서 로그아웃했어요');
    expect(auth.logout).not.toHaveBeenCalled();
    await unmount();
  });

  it('그만두면 아무 세션도 끝내지 않는다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { container, unmount } = await mount(shell());
    await openMenu(container);
    await act(async () => button('다른 기기에서 모두 로그아웃')!.click());
    expect(api.logoutOthers).not.toHaveBeenCalled();
    expect(container.querySelector('[role=status]')).toBeNull();
    await unmount();
  });

  it('실패하면 서버가 말한 문제를 보이고, 메뉴를 다시 열면 지난 결과는 사라져 있다', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.logoutOthers.mockRejectedValueOnce(new ApiRequestError(429, 'rate_limited', '잠시 후 다시 시도해 주세요.'));
    const { container, unmount } = await mount(shell());
    await openMenu(container);
    await act(async () => button('다른 기기에서 모두 로그아웃')!.click());
    expect(container.querySelector('[role=alert]')?.textContent).toBe('잠시 후 다시 시도해 주세요.');
    await openMenu(container);
    expect(container.querySelector('.mg-popover')).toBeNull();
    await openMenu(container);
    expect(container.querySelector('[role=alert]')).toBeNull();

    api.logoutOthers.mockResolvedValueOnce({ ended: 1 });
    await act(async () => button('다른 기기에서 모두 로그아웃')!.click());
    expect(container.querySelector('[role=status]')?.textContent).toBe('다른 기기 1곳에서 로그아웃했어요');
    await openMenu(container);
    await openMenu(container);
    expect(container.querySelector('[role=status]')).toBeNull();
    await unmount();
  });
});

describe('운영 메뉴', () => {
  const as = (permissions: User['permissions']): User => ({ ...mogae, permissions });

  it('카탈로그 편집자는 /admin으로, 운영자(유료 운영자 포함)는 캐릭터 공장으로 가고, 둘 다 아니면 메뉴가 없다', async () => {
    expect(adminHome(as(['catalog_editor', 'studio_viewer']))).toBe('/admin');
    expect(adminHome(as(['operator']))).toBe('/admin/studio');
    expect(adminHome(as(['paid_operator', 'operator']))).toBe('/admin/studio');
    expect(adminHome(as(['moderator']))).toBeNull();
    expect(adminHome(null)).toBeNull();

    auth.user = as(['paid_operator', 'operator']);
    const { container, unmount } = await mount(
      <MemoryRouter initialEntries={['/admin/studio/bodies']}>
        <Rail />
      </MemoryRouter>,
    );
    const link = [...container.querySelectorAll('a')].find((anchor) => anchor.textContent === '운영');
    expect(link?.getAttribute('href')).toBe('/admin/studio');
    expect(link?.getAttribute('aria-current')).toBe('page');
    await unmount();

    auth.user = mogae;
    const member = await mount(
      <MemoryRouter>
        <Rail />
      </MemoryRouter>,
    );
    expect(member.container.textContent).not.toContain('운영');
    await member.unmount();
  });
});

describe('로그아웃', () => {
  it('저장하지 못한 편집이 있으면 먼저 묻고, 그만두면 로그아웃하지 않는다', async () => {
    const untrack = trackUnsaved(() => true);
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { container, unmount } = await mount(shell());
    await openMenu(container);
    await act(async () => button('로그아웃')!.click());
    expect(ask).toHaveBeenCalledTimes(1);
    expect(auth.logout).not.toHaveBeenCalled();
    await act(async () => button('로그아웃')!.click());
    expect(auth.logout).toHaveBeenCalledTimes(1);
    untrack();
    await unmount();
  });

  it('세션이 풀린 채로도 로그아웃할 수 있다', async () => {
    auth.user = null;
    auth.lapsed = mogae;
    const { container, unmount } = await mount(shell());
    expect(container.querySelector('a')?.textContent).toBe('로그인');
    await act(async () => button('로그아웃')!.click());
    expect(auth.logout).toHaveBeenCalledTimes(1);
    await unmount();
  });
});

describe('알림', () => {
  it('받은 신청이 여럿이면 모두 거절할 수 있다', async () => {
    const request = (name: string) => ({ id: `r-${name}`, from: { username: name, displayName: name }, theirName: name, message: '' });
    api.requests.mockResolvedValueOnce({ received: [request('a'), request('b')], sent: [] });
    api.dismissAll.mockResolvedValueOnce({ dismissed: 2 });
    const { container, unmount } = await mount(shell());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-haspopup=dialog]')!.click());
    await act(async () => button('모두 거절')!.click());
    expect(api.dismissAll).toHaveBeenCalledOnce();
    // The list is read again, now empty.
    expect(container.querySelector<HTMLButtonElement>('[aria-haspopup=dialog]')!.getAttribute('aria-label')).toBe('알림');
    await unmount();
  });

  it('다른 사람이 로그인하면 이전 사람의 목록을 비우고, 그 사람에 대한 늦은 답은 버린다', async () => {
    const request = (name: string) => ({
      id: `r-${name}`,
      from: { username: name, displayName: name },
      theirName: name,
      message: '',
    });
    let late!: (value: unknown) => void;
    api.requests
      .mockResolvedValueOnce({ received: [request('a')], sent: [] })
      .mockImplementationOnce(() => new Promise((resolve) => (late = resolve)))
      .mockResolvedValue({ received: [], sent: [] });
    const { container, rerender, unmount } = await mount(shell());
    const bell = () => container.querySelector<HTMLButtonElement>('[aria-haspopup=dialog]')!;
    expect(bell().getAttribute('aria-label')).toBe('알림 1개');
    expect(bell().hasAttribute('aria-controls')).toBe(false);
    await act(async () => bell().click());
    expect(document.getElementById(bell().getAttribute('aria-controls')!)?.getAttribute('role')).toBe('dialog');

    // Asked again for the first member, then someone else signs in before the answer comes.
    await act(async () => window.dispatchEvent(new Event('mogaesup:requests')));
    auth.user = { ...mogae, id: 'u2', username: 'other' };
    await rerender(shell());
    expect(bell().getAttribute('aria-label')).toBe('알림');
    await act(async () => late({ received: [request('b')], sent: [] }));
    expect(bell().getAttribute('aria-label')).toBe('알림');
    await unmount();
  });
});
