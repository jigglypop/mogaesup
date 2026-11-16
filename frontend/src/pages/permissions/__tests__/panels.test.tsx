import { act, type ReactNode } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditEntry, Change, GroupRow, Person, PersonMatch, UserNames } from '../../../api/permissions';
import { ApiRequestError } from '../../../api/client';
import type { User } from '../../../api/types';
import { mount, type } from '../../../__tests__/mount';
import { AuditPanel } from '../AuditPanel';
import { GroupsPanel } from '../GroupsPanel';
import PermissionsPage, { type Apply } from '../PermissionsPage';

type Page = { entries: AuditEntry[]; users: UserNames; nextBefore: number | null };
const { search, person, audit, grant, revoke, check, groups } = vi.hoisted(() => ({
  search: vi.fn<(q: string) => Promise<{ matches: PersonMatch[]; users: UserNames }>>(),
  person: vi.fn<(username: string) => Promise<Person>>(),
  audit: vi.fn<(query: { subject?: string; limit?: number; before?: number }) => Promise<Page>>(),
  grant: vi.fn<(change: Change) => Promise<{ changed: boolean }>>(),
  revoke: vi.fn<(change: Change) => Promise<{ changed: boolean }>>(),
  check: vi.fn(),
  groups: vi.fn<() => Promise<{ groups: GroupRow[]; users: UserNames }>>(),
}));
vi.mock('../../../api/permissions', () => ({ permissionsApi: { search, person, audit, grant, revoke, check, groups } }));
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
/** Group crew with `count` people in it. */
const crew = (count: number): GroupRow => ({
  id: 'crew',
  members: Array.from({ length: count }, (_, index) => ({
    object: 'group:crew',
    relation: 'member',
    subject: `user:u${index + 1}`,
    createdAt: '2026-10-01T00:00:00Z',
    createdBy: 'boss',
  })),
  grants: [],
});
const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label);
const flush = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
const choose = (select: HTMLSelectElement, value: string) =>
  act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

afterEach(() => {
  for (const mock of [search, person, audit, grant, revoke, check, groups]) mock.mockReset();
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

  it('권한이 바뀌어 첫 페이지를 다시 읽으면, 그 전에 누른 더 보기의 늦은 답은 붙이지 않는다', async () => {
    audit.mockResolvedValueOnce({ entries: [entry(9)], users: {}, nextBefore: 9 });
    const { container, rerender, unmount } = await mount(<AuditPanel revision={0} />);
    await flush();
    let late!: (page: Page) => void;
    audit.mockImplementationOnce(() => new Promise((resolve) => (late = resolve)));
    await act(async () => button(container, '더 보기')!.click());
    audit.mockResolvedValueOnce({ entries: [entry(10), entry(9)], users: {}, nextBefore: 9 });
    await rerender(<AuditPanel revision={1} />);
    await flush();
    await act(async () => late({ entries: [entry(8)], users: {}, nextBefore: null }));
    expect([...container.querySelectorAll('.mg-perm-audit li')]).toHaveLength(2);
    // The new first page's cursor still asks for what follows it.
    expect(button(container, '더 보기')?.disabled).toBe(false);
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

describe('그룹', () => {
  it('목록을 읽지 못하면 다시 불러올 수 있고, 다음 읽기가 성공하면 문제를 지운다', async () => {
    const apply = vi.fn<Apply>();
    groups.mockRejectedValueOnce(new ApiRequestError(503, 'database', '서버가 잠시 대답하지 않아요'));
    const { container, rerender, unmount } = await mount(<GroupsPanel apply={apply} revision={0} />);
    await flush();
    expect(container.querySelector('[role=alert]')?.textContent).toContain('서버가 잠시 대답하지 않아요');
    expect(container.textContent).not.toContain('불러오는 중');
    groups.mockResolvedValueOnce({ groups: [crew(1)], users: {} });
    await act(async () => button(container, '다시 불러오기')!.click());
    await flush();
    expect(container.querySelector('[role=alert]')).toBeNull();
    expect(container.textContent).toContain('그룹 crew');

    // The read after one change fails; the read after the next change works and the problem goes with it.
    groups.mockRejectedValueOnce(new ApiRequestError(503, 'database', '서버가 잠시 대답하지 않아요'));
    await rerender(<GroupsPanel apply={apply} revision={1} />);
    await flush();
    expect(container.querySelector('[role=alert]')).not.toBeNull();
    groups.mockResolvedValueOnce({ groups: [crew(2)], users: {} });
    await rerender(<GroupsPanel apply={apply} revision={2} />);
    await flush();
    expect(container.querySelector('[role=alert]')).toBeNull();
    expect(container.querySelector('.mg-perm-group small')?.textContent).toBe('구성원 2');
    await unmount();
  });

  it('새 그룹 이름의 문제는 목록을 읽지 못한 문제를 가리지 않는다', async () => {
    const apply = vi.fn<Apply>();
    groups.mockRejectedValueOnce(new ApiRequestError(503, 'database', '서버가 잠시 대답하지 않아요'));
    const { container, unmount } = await mount(<GroupsPanel apply={apply} revision={0} />);
    await flush();
    await type(container.querySelector<HTMLInputElement>('[aria-label="새 그룹 이름"]')!, 'A');
    await type(container.querySelector<HTMLInputElement>('[aria-label="첫 구성원 아이디"]')!, 'mogae');
    await act(async () => button(container, '만들기')!.click());
    expect(apply).not.toHaveBeenCalled();
    expect(container.querySelector('.mg-error')?.textContent).toContain('그룹 이름은');
    expect(container.querySelector('[role=alert]')?.textContent).toContain('서버가 잠시 대답하지 않아요');
    expect(button(container, '다시 불러오기')).toBeDefined();
    await unmount();
  });

  it('역할을 고르기 전에는 줄 수 없고, 유료 작업·스튜디오 운영은 구성원 수를 보고 확인한 뒤에만 준다', async () => {
    const apply = vi.fn<Apply>().mockResolvedValue(true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    groups.mockResolvedValue({ groups: [crew(3)], users: {} });
    const { container, unmount } = await mount(<GroupsPanel apply={apply} revision={0} />);
    await flush();
    const select = container.querySelector<HTMLSelectElement>('select')!;
    const give = () => button(container, '역할 주기')!;
    expect(select.value).toBe('');
    expect(give().disabled).toBe(true);

    await choose(select, 'paid_operator');
    expect(give().disabled).toBe(false);
    await act(async () => give().click());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('구성원 3'));
    expect(apply).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await act(async () => give().click());
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'grant', object: 'system:mogaesup', relation: 'paid_operator', subject: 'group:crew#member' }),
    );

    confirm.mockClear();
    confirm.mockReturnValue(false);
    await choose(select, 'operator');
    await act(async () => give().click());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('스튜디오 운영'));
    expect(apply).toHaveBeenCalledTimes(1);

    // A role that spends nothing and changes no studio record is given without asking.
    confirm.mockClear();
    await choose(select, 'catalog_editor');
    await act(async () => give().click());
    expect(confirm).not.toHaveBeenCalled();
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ object: 'catalog:mogaesup', relation: 'editor' }));
    confirm.mockRestore();
    await unmount();
  });
});
