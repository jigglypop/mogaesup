import { act, type ReactNode } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { CatalogImport, FactoryImport, User } from '../../api/types';
import { mount } from '../../__tests__/mount';
import { AdminPage } from '../AdminPage';

const catalogApi = vi.hoisted(() => ({
  adminItems: vi.fn(async () => ({ items: [] })),
  factoryCharacters: vi.fn(async () => ({ characters: [] })),
  imports: vi.fn<() => Promise<{ imports: CatalogImport[] }>>(),
  importFactory: vi.fn<(body: FactoryImport) => Promise<CatalogImport>>(),
}));
const editor: User = { id: 'u1', username: 'mogae', displayName: '모개', role: 'user', permissions: ['catalog_editor'] };
vi.mock('../../api/endpoints', () => ({ catalogApi }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ status: 'signedIn', user: editor }) }));
vi.mock('../../shell/Shell', () => ({ PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../../studio/StudioPower', () => ({ StudioPowerLine: () => null, WakeBanner: () => null, useEvery: () => {} }));

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
