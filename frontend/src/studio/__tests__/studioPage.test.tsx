import type { ReactNode } from 'react';

import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { catalogApi } from '../../api/endpoints';
import type { PermissionName, User } from '../../api/types';
import { mount } from '../../__tests__/mount';
import StudioPage from '../StudioPage';

const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: auth.user, status: 'signedIn' }) }));
vi.mock('../../shell/Shell', () => ({ PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../../pages/AdminTabs', () => ({ AdminTabs: () => null }));
vi.mock('../../character/studio/Workspace', () => ({ Workspace: () => <p>작업 화면</p> }));
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
    await unmount();
  });
});
