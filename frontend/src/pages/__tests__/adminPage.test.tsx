import { act, type ReactNode } from 'react';

import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CatalogImport, FactoryImport, User } from '../../api/types';
import { mount } from '../../__tests__/mount';

const catalogApi = vi.hoisted(() => ({
  adminItems: vi.fn(async () => ({ items: [] })),
  factoryCharacters: vi.fn(async () => ({ characters: [] })),
  imports: vi.fn<() => Promise<{ imports: CatalogImport[] }>>(async () => ({ imports: [] })),
  importFactory: vi.fn<(body: FactoryImport) => Promise<CatalogImport>>(),
}));
vi.mock('../../api/endpoints', () => ({ catalogApi }));
const auth = vi.hoisted(() => ({ status: 'signedIn', user: null as User | null }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => auth }));
vi.mock('../../shell/Shell', async (original) => ({
  ...(await original<typeof import('../../shell/Shell')>()),
  PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../studio/StudioPower', () => ({ StudioPowerLine: () => null, WakeBanner: () => null, useEvery: () => {} }));

import { AdminPage } from '../AdminPage';

const member: User = { id: 'u1', username: 'mogae', displayName: '모개', role: 'user' };
const editor: User = { ...member, permissions: ['catalog_editor'] };

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
    expect(catalogApi.adminItems).not.toHaveBeenCalled();
  });

  it('운영 권한이 없는 회원은 자기 섬으로 보낸다', async () => {
    auth.user = { ...member, permissions: ['moderator'] };
    const { container, unmount } = await open('/admin');
    expect(container.querySelector('.where')?.textContent).toBe('/@mogae');
    await unmount();
  });
});

const failed = (id: string, replaces: boolean): CatalogImport => ({
  id,
  itemId: `item-${id}`,
  kind: 'minime',
  label: `이름 ${id}`,
  emoji: '🙂',
  factoryJobId: `job-${id}`,
  characterId: null,
  replaces,
  status: 'failed',
  step: 'download',
  progress: 30,
  detail: null,
  errorCode: 'factory_unavailable',
  errorMessage: '캐릭터 서버에 연결하지 못했습니다.',
  report: null,
  versionId: null,
  requestedBy: 'mogae',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  finishedAt: '2026-10-01T00:00:00Z',
});

describe('운영 화면의 가져오기 다시 시도', () => {
  it('새 항목으로 시작한 가져오기는 다시 보내도 새 항목만 만들고, 업데이트는 업데이트로 보낸다', async () => {
    auth.user = editor;
    catalogApi.imports.mockResolvedValue({ imports: [failed('a', false), failed('b', true)] });
    catalogApi.importFactory.mockImplementation(async (body) => ({ ...failed(`retry-${body.id}`, !body.create), status: 'queued' }));
    const { container, unmount } = await mount(
      <MemoryRouter initialEntries={['/admin']}>
        <AdminPage />
      </MemoryRouter>,
    );
    const retry = (label: string) => {
      const row = [...container.querySelectorAll('li')].find((item) => item.textContent?.includes(label))!;
      return [...row.querySelectorAll('button')].find((button) => button.textContent?.includes('다시 시도'))!;
    };
    await act(async () => retry('이름 a').click());
    await act(async () => retry('이름 b').click());
    expect(catalogApi.importFactory.mock.calls.map(([body]) => [body.id, body.create])).toEqual([
      ['item-a', true],
      ['item-b', false],
    ]);
    await unmount();
  });
});
