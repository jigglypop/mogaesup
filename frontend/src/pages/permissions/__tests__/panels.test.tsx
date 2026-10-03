import { act, type ReactNode } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditEntry, Change, Person, PersonMatch, UserNames } from '../../../api/permissions';
import { ApiRequestError } from '../../../api/client';
import type { User } from '../../../api/types';
import { mount, type } from '../../../__tests__/mount';
import { AuditPanel } from '../AuditPanel';
import PermissionsPage from '../PermissionsPage';

type Page = { entries: AuditEntry[]; users: UserNames; nextBefore: number | null };
const { search, person, audit, grant, revoke, check } = vi.hoisted(() => ({
  search: vi.fn<(q: string) => Promise<{ matches: PersonMatch[]; users: UserNames }>>(),
  person: vi.fn<(username: string) => Promise<Person>>(),
  audit: vi.fn<(query: { subject?: string; limit?: number; before?: number }) => Promise<Page>>(),
  grant: vi.fn<(change: Change) => Promise<{ changed: boolean }>>(),
  revoke: vi.fn<(change: Change) => Promise<{ changed: boolean }>>(),
  check: vi.fn(),
}));
vi.mock('../../../api/permissions', () => ({ permissionsApi: { search, person, audit, grant, revoke, check } }));
const admin: User = { id: 'a1', username: 'boss', displayName: '관리자', role: 'admin' };
vi.mock('../../../auth/AuthProvider', () => ({ useAuth: () => ({ status: 'signedIn', user: admin }) }));
vi.mock('../../../shell/Shell', () => ({ PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../../AdminTabs', () => ({ AdminTabs: () => null }));

const mogae: PersonMatch = { id: 'u1', username: 'mogae', displayName: '모개', createdAt: '2026-09-01T00:00:00Z', grants: [] };
const entry = (id: number): AuditEntry => ({
  id,
  action: 'grant',
  object: 'system:mogaesup',
  relation: 'operator',
  subject: 'user:u1',
  actor: 'boss',
  actorId: 'a1',
  reason: '운영 맡김',
  createdAt: '2026-10-01T00:00:00Z',
});
const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label);
const flush = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });

afterEach(() => {
  for (const mock of [search, person, audit, grant, revoke, check]) mock.mockReset();
});

describe('권한 화면의 불러오기', () => {
  it('사람 찾기가 실패하면 불러오는 중이라고 하지 않고 문제와 다시 불러오기를 보인다', async () => {
    search.mockRejectedValueOnce(new ApiRequestError(503, 'database', '서버가 잠시 대답하지 않아요'));
    const { container, unmount } = await mount(<MemoryRouter><PermissionsPage /></MemoryRouter>);
    await flush();
    expect(container.querySelector('[role=alert]')?.textContent).toContain('서버가 잠시 대답하지 않아요');
    expect(container.textContent).not.toContain('불러오는 중');

    search.mockResolvedValueOnce({ matches: [mogae], users: {} });
    await act(async () => button(container, '다시 불러오기')!.click());
    await flush();
    expect(container.querySelector('[role=alert]')).toBeNull();
    expect(container.textContent).toContain('@mogae');
    await unmount();
  });

  it('더 보기가 실패한 뒤 다시 성공하면 문제를 지운다', async () => {
    audit.mockResolvedValueOnce({ entries: [entry(9)], users: {}, nextBefore: 9 });
    const { container, unmount } = await mount(<AuditPanel revision={0} />);
    await flush();
    audit.mockRejectedValueOnce(new ApiRequestError(500, 'database', '기록을 읽지 못했어요'));
    await act(async () => button(container, '더 보기')!.click());
    await flush();
    expect(container.querySelector('[role=alert]')?.textContent).toContain('기록을 읽지 못했어요');

    audit.mockResolvedValueOnce({ entries: [entry(8)], users: {}, nextBefore: null });
    await act(async () => button(container, '더 보기')!.click());
    await flush();
    expect(container.querySelector('[role=alert]')).toBeNull();
    expect(container.querySelectorAll('.mg-perm-audit li')).toHaveLength(2);
    await unmount();
  });

  it('기록을 처음부터 읽지 못하면 다시 불러올 수 있다', async () => {
    audit.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { container, unmount } = await mount(<AuditPanel revision={0} />);
    await flush();
    expect(container.querySelector('[role=alert]')).not.toBeNull();
    audit.mockResolvedValueOnce({ entries: [entry(1)], users: {}, nextBefore: null });
    await act(async () => button(container, '다시 불러오기')!.click());
    await flush();
    expect(container.querySelector('[role=alert]')).toBeNull();
    expect(container.querySelectorAll('.mg-perm-audit li')).toHaveLength(1);
    await unmount();
  });
});

describe('권한 바꾸기', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false })));
  afterEach(() => vi.unstubAllGlobals());

  it('변경이 끝나면 사유를 비워, 다음 변경이 앞 사유로 기록되지 않는다', async () => {
    search.mockResolvedValue({ matches: [mogae], users: {} });
    person.mockResolvedValue({
      user: { id: 'u1', username: 'mogae', displayName: '모개', createdAt: '2026-09-01T00:00:00Z' },
      grants: [],
      permissions: { admin: false, paid_operator: false, operator: false, moderator: false, catalog_editor: false, studio_viewer: false },
      users: {},
    });
    audit.mockResolvedValue({ entries: [], users: {}, nextBefore: null });
    grant.mockResolvedValue({ changed: true });
    const { container, unmount } = await mount(<MemoryRouter><PermissionsPage /></MemoryRouter>);
    await flush();
    await act(async () => container.querySelector<HTMLButtonElement>('.mg-perm-list button')!.click());
    await flush();
    const reason = () => container.querySelector<HTMLInputElement>('.mg-perm-reason input')!;
    await type(reason(), '스튜디오 운영 맡김');
    const give = () => [...container.querySelectorAll<HTMLButtonElement>('.mg-perm-roles li')].find((row) => row.textContent?.includes('스튜디오 운영'))!.querySelector<HTMLButtonElement>('.mg-admin-actions button:last-child')!;
    await act(async () => give().click());
    await flush();
    expect(grant).toHaveBeenCalledWith(expect.objectContaining({ relation: 'operator', reason: '스튜디오 운영 맡김' }));
    expect(reason().value).toBe('');

    // The next change needs its own reason.
    await act(async () => give().click());
    await flush();
    expect(grant).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role=alert]')?.textContent).toContain('변경 사유를 적어 주세요');
    await unmount();
  });
});
