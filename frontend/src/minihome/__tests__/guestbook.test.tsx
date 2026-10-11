import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../api/client';
import type { GuestbookEntry, GuestbookPage, User } from '../../api/types';
import { mount, type } from '../../__tests__/mount';
import { Guestbook } from '../Guestbook';

const { guestbook, write, remove, removeByAuthor } = vi.hoisted(() => ({
  guestbook: vi.fn<(username: string, before?: string, signal?: AbortSignal) => Promise<GuestbookPage>>(),
  write: vi.fn<() => Promise<{ id: string }>>(), remove: vi.fn<() => Promise<void>>(),
  removeByAuthor: vi.fn<(username: string, author: string) => Promise<{ deleted: number }>>(),
}));
vi.mock('../../api/endpoints', () => ({ socialApi: { guestbook, write, remove, removeByAuthor } }));
vi.mock('../../shell/Shell', () => ({ initialOf: (name: string) => name[0], toneOf: () => '0' }));

const viewer: User = { id: 'owner', username: 'me', displayName: '나', role: 'user' };
const entry = (id: string): GuestbookEntry => ({
  id, author: { id: 'author', username: 'writer', displayName: '글쓴이', emoji: '😊' },
  body: `글 ${id}`, secret: false, canDelete: false, createdAt: '2026-10-01T00:00:00Z',
});
const page = (ids: string[], nextBefore: string | null = null): GuestbookPage => ({ entries: ids.map(entry), total: 3, nextBefore });
const screen = (username = 'home', who: User | null = viewer) => <MemoryRouter><Guestbook username={username} viewer={who} /></MemoryRouter>;
const refusal = () => new ApiRequestError(401, 'login_required', '로그인이 필요합니다.');
const submit = (container: HTMLElement) =>
  act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)!;

describe('방명록 요청', () => {
  beforeEach(() => { guestbook.mockResolvedValue(page(['1'], 'cursor')); });
  afterEach(() => { guestbook.mockReset(); write.mockReset(); remove.mockReset(); removeByAuthor.mockReset(); vi.restoreAllMocks(); });

  it('섬 주인은 한 사람의 글을 묻고 나서 모두 지운다; 다른 섬에서는 그 버튼이 없다', async () => {
    removeByAuthor.mockResolvedValueOnce({ deleted: 2 });
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const own = await mount(screen('me'));
    const clear = own.container.querySelector<HTMLButtonElement>('[aria-label="글쓴이의 글 모두 삭제"]')!;
    await act(async () => clear.click());
    expect(removeByAuthor).not.toHaveBeenCalled();
    guestbook.mockResolvedValueOnce({ entries: [], total: 0, nextBefore: null });
    await act(async () => clear.click());
    expect(ask).toHaveBeenCalledTimes(2);
    expect(removeByAuthor).toHaveBeenCalledExactlyOnceWith('me', 'writer');
    expect(own.container.querySelectorAll('.mg-entries li')).toHaveLength(0);
    await own.unmount();
    const other = await mount(screen('home'));
    expect(other.container.querySelector('[aria-label="글쓴이의 글 모두 삭제"]')).toBeNull();
    await other.unmount();
  });

  it('로그인하지 않은 방문자의 로그인 링크는 로그인한 뒤 이 섬으로 돌아온다', async () => {
    const { container, unmount } = await mount(
      <MemoryRouter initialEntries={['/@home']}>
        <Guestbook username="home" viewer={null} />
      </MemoryRouter>,
    );
    const link = [...container.querySelectorAll('a')].find((anchor) => anchor.textContent === '로그인');
    expect(link?.getAttribute('href')).toBe('/?next=%2F%40home');
    await unmount();
  });

  it('응답 전 두 번 제출해도 글은 한 번만 쓴다', async () => {
    let finish!: (result: { id: string }) => void;
    write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { container, unmount } = await mount(screen());
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, '안녕하세요');
    await act(async () => {
      const form = container.querySelector('form')!;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);
    await act(async () => { finish({ id: 'new' }); });
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('');
    await unmount();
  });

  it('세션이 끊겨 거절된 글은 오류와 함께 남아, 같은 사람이 다시 로그인하면 이어 쓰고 다른 사람이면 비운다', async () => {
    write.mockRejectedValueOnce(refusal());
    const { container, rerender, unmount } = await mount(screen());
    const box = () => container.querySelector<HTMLTextAreaElement>('textarea');
    const secret = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const alert = () => container.querySelector('[role="alert"]')?.textContent;
    await type(box()!, '오래 쓴 글');
    await act(async () => { secret()!.click(); });
    await submit(container);
    // The refusal signs the member out (no viewer); the note waits for them, and the refusal stays said.
    await rerender(screen('home', null));
    expect(box()).toBeNull();
    expect(alert()).toBe('로그인이 필요합니다.');
    await rerender(screen());
    expect(box()!.value).toBe('오래 쓴 글');
    expect(secret()!.checked).toBe(true);
    expect(alert()).toBeUndefined();
    await rerender(screen('home', { ...viewer, id: 'other', username: 'other' }));
    expect(box()!.value).toBe('');
    expect(secret()!.checked).toBe(false);
    await unmount();
  });

  it('세션이 먼저 끊긴 뒤 늦게 온 거절도 알린다', async () => {
    let refuse!: (problem: unknown) => void;
    write.mockImplementationOnce(() => new Promise((_, reject) => { refuse = reject; }));
    const { container, rerender, unmount } = await mount(screen());
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, '오래 쓴 글');
    await submit(container);
    await rerender(screen('home', null));
    await act(async () => { refuse(refusal()); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('로그인이 필요합니다.');
    await rerender(screen());
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('오래 쓴 글');
    await unmount();
  });

  it('다른 섬으로 옮긴 뒤 늦게 온, 세션과 상관없는 거절은 새 섬에 보이지 않는다', async () => {
    let refuse!: (problem: unknown) => void;
    write.mockImplementationOnce(() => new Promise((_, reject) => { refuse = reject; }));
    const { container, rerender, unmount } = await mount(screen('first'));
    await type(container.querySelector<HTMLTextAreaElement>('textarea')!, '오래 쓴 글');
    await submit(container);
    await rerender(screen('second'));
    // Not the server's refusal of the session (a proxy's own 401, say): nobody was signed out.
    await act(async () => { refuse(new ApiRequestError(401, 'http_error', '요청이 실패했어요 (401)')); });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('');
    await unmount();
  });

  it('더 보기의 연속 클릭은 한 요청이고 겹친 항목은 중복으로 표시하지 않는다', async () => {
    const { container, unmount } = await mount(screen());
    let answer!: (value: GuestbookPage) => void;
    guestbook.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    await act(async () => { const more = button(container, '더 보기'); more.click(); more.click(); });
    expect(guestbook).toHaveBeenCalledTimes(2);
    await act(async () => { answer(page(['1', '2'])); });
    expect([...container.querySelectorAll('.mg-entry-body')].map(item => item.textContent)).toEqual(['글 1', '글 2']);
    await unmount();
  });

  it('섬을 바꾸면 이전 읽기를 취소하고 늦은 응답을 새 섬에 붙이지 않는다', async () => {
    let old!: (value: GuestbookPage) => void;
    guestbook.mockImplementationOnce(() => new Promise(resolve => { old = resolve; }));
    const { container, rerender, unmount } = await mount(screen('first'));
    guestbook.mockResolvedValueOnce(page(['new']));
    await rerender(screen('second'));
    expect(guestbook.mock.calls[0]?.[2]?.aborted).toBe(true);
    await act(async () => { old(page(['old'])); });
    expect(container.textContent).toContain('글 new'); expect(container.textContent).not.toContain('글 old');
    await unmount();
  });
});
