import { act, type ReactNode } from 'react';

import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../api/client';
import { catalogApi } from '../../api/endpoints';
import type { PermissionName, User } from '../../api/types';
import { mount } from '../../__tests__/mount';
import StudioPage from '../StudioPage';
import { USAGE_REFRESH_MS } from '../usage';

const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: auth.user, status: 'signedIn' }) }));
vi.mock('../../shell/Shell', () => ({ PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../../pages/AdminTabs', () => ({ AdminTabs: () => null }));
// The screen only has to say whether it was told paid work is open to this viewer here.
vi.mock('../../character/studio/Workspace', async () => {
  const { usePaidWork } = await import('../usage');
  return { Workspace: () => <p>작업 화면{usePaidWork() ? ' · 유료 작업 가능' : ''}</p> };
});
vi.mock('../StudioPower', () => ({ StudioPowerLine: () => null, StudioWaking: () => null }));

const user = (...permissions: PermissionName[]): User => ({ id: 'u1', username: 'mogae', displayName: '모개', role: 'user', permissions });
const flush = () => new Promise((done) => setTimeout(done, 0));
const Where = () => <output>{useLocation().pathname}</output>;

describe('캐릭터 공장 화면', () => {
  beforeEach(() => {
    vi.spyOn(catalogApi, 'factoryUsage').mockResolvedValue({ connected: false });
  });
  afterEach(() => vi.restoreAllMocks());

  const open = async (path: string) => {
    const mounted = await mount(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/studio/*" element={<><StudioPage /><Where /></>} />
          <Route path="/character" element={<Where />} />
          <Route path="/" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    await flush();
    return mounted;
  };
  const menu = (container: HTMLElement) => [...container.querySelectorAll('nav[aria-label="캐릭터 공장"] a')].map((link) => link.querySelector('span')?.textContent);
  const where = (container: HTMLElement) => container.querySelector('output')?.textContent;

  it('유료 작업자는 만들기 화면 전부와 관리 화면을 본다', async () => {
    auth.user = user('operator', 'paid_operator');
    const { container, unmount } = await open('/admin/studio/make/body');
    expect(menu(container)).toEqual(['사진으로 전체 생성', '기본몸', '파츠', '동물', '기물', '바닥 타일', '2D 이모티콘', '에셋 라이브러리', '프롬프트']);
    expect(where(container)).toBe('/admin/studio/make/body');
    expect(container.textContent).toContain('작업 화면');
    await unmount();
  });

  it('유료 작업자가 아닌 운영자에게는 유료 작업을 시작하는 화면이 메뉴에도 주소로도 없다', async () => {
    auth.user = user('operator');
    for (const path of ['/admin/studio/make/photo', '/admin/studio/make/body', '/admin/studio/assets/textures', '/admin/studio']) {
      const { container, unmount } = await open(path);
      expect(menu(container)).toEqual(['에셋 라이브러리', '프롬프트']);
      expect(where(container)).toBe('/admin/studio/library');
      await unmount();
    }
  });

  it('관리 화면은 유료 작업자가 아니어도 열린다', async () => {
    auth.user = user('operator');
    const { container, unmount } = await open('/admin/studio/prompts');
    expect(where(container)).toBe('/admin/studio/prompts');
    await unmount();
  });

  it('운영자가 아니면 옷장으로 보낸다', async () => {
    auth.user = user();
    const { container, unmount } = await open('/admin/studio/library');
    expect(where(container)).toBe('/character');
    expect(catalogApi.factoryUsage).not.toHaveBeenCalled();
    await unmount();
  });
});

describe('캐릭터 서버 연결 표시', () => {
  const usage = vi.fn<typeof catalogApi.factoryUsage>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(catalogApi, 'factoryUsage').mockImplementation(usage);
    auth.user = user('operator', 'paid_operator');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    usage.mockReset();
  });
  const wait = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const open = async () => {
    const mounted = await mount(
      <MemoryRouter initialEntries={['/admin/studio/library']}>
        <Routes>
          <Route path="/admin/studio/*" element={<StudioPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await wait(0);
    return mounted;
  };
  const line = (container: HTMLElement) => container.querySelector('.mg-studio-connection [role=status]')?.textContent;

  it('읽지 못한 것과 연결이 안 된 것을 구분하고, 1분마다 다시 읽는다', async () => {
    usage.mockRejectedValueOnce(new ApiRequestError(502, 'bad_gateway', '응답 없음')).mockResolvedValue({ connected: false });
    const { container, unmount } = await open();
    expect(line(container)).toBe('캐릭터 서버 상태를 읽지 못함');
    expect(container.querySelector('.mg-studio-connection button')?.textContent).toBe('다시 확인');
    await wait(USAGE_REFRESH_MS);
    expect(usage).toHaveBeenCalledTimes(2);
    expect(line(container)).toBe('캐릭터 서버 연결 안 됨');
    expect(container.querySelector('.mg-studio-connection button')).toBeNull();

    usage.mockResolvedValue({ connected: true, access: 'paid', paidThisMonth: 3, paidMonthly: 50 });
    await wait(USAGE_REFRESH_MS);
    expect(line(container)).toBe('캐릭터 서버 · 유료 작업까지');
    expect(container.textContent).toContain('이번 달 유료 작업 3 / 50');
    await unmount();
    await wait(USAGE_REFRESH_MS * 3);
    expect(usage).toHaveBeenCalledTimes(3);
  });

  it('읽기에 실패하면 다시 확인으로 바로 다시 읽는다', async () => {
    usage.mockRejectedValueOnce(new ApiRequestError(502, 'bad_gateway', '응답 없음')).mockResolvedValue({ connected: true, access: 'write', paidThisMonth: 0, paidMonthly: 0 });
    const { container, unmount } = await open();
    await act(async () => container.querySelector<HTMLButtonElement>('.mg-studio-connection button')!.click());
    await wait(0);
    expect(usage).toHaveBeenCalledTimes(2);
    expect(line(container)).toBe('캐릭터 서버 · 기록 바꾸기까지');
    await unmount();
  });

  it.each([
    ['유료 작업이 열린 서버', { connected: true, access: 'paid', paidThisMonth: 0, paidMonthly: 10 }, true],
    ['기록까지만 허락한 서버', { connected: true, access: 'write', paidThisMonth: 0, paidMonthly: 10 }, false],
    ['연결되지 않은 서버', { connected: false }, false],
  ] as const)('%s에서 화면에 유료 작업 가능 여부를 알린다', async (_server, answer, paid) => {
    usage.mockResolvedValue(answer);
    const { container, unmount } = await open();
    expect(container.textContent?.includes('작업 화면 · 유료 작업 가능')).toBe(paid);
    await unmount();
  });

  it('유료 운영자가 아니면 서버가 허락해도 유료 작업을 알리지 않는다', async () => {
    auth.user = user('operator');
    usage.mockResolvedValue({ connected: true, access: 'paid', paidThisMonth: 0, paidMonthly: 10 });
    const { container, unmount } = await open();
    expect(container.textContent).toContain('작업 화면');
    expect(container.textContent).not.toContain('유료 작업 가능');
    await unmount();
  });
});
