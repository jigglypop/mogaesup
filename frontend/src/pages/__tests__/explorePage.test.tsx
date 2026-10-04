import { act, type ReactNode } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HomeListQuery, HomeSummary } from '../../api/types';
import { mount, type } from '../../__tests__/mount';
import { ExplorePage } from '../ExplorePage';
import { EXPLORE_PAGE } from '../explore';

const { list } = vi.hoisted(() => ({
  list: vi.fn<(query?: HomeListQuery, signal?: AbortSignal) => Promise<{ homes: HomeSummary[] }>>(),
}));
vi.mock('../../api/endpoints', () => ({ homeApi: { list } }));
vi.mock('../../shell/Shell', () => ({ PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

const home = (index: number): HomeSummary => ({
  username: `user${index}`,
  ownerName: `주인${index}`,
  title: `섬${index}`,
  statusMessage: '',
  emoji: '😊',
  updatedAt: `2026-09-${String(30 - Math.floor(index / 10)).padStart(2, '0')}T00:00:${String(59 - (index % 60)).padStart(2, '0')}Z`,
  total: index,
});
const page = (count: number, from = 0) => Array.from({ length: count }, (_, index) => home(from + index));
const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

describe('둘러보기 화면', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    list.mockReset();
  });

  const open = (path = '/explore') =>
    mount(
      <MemoryRouter initialEntries={[path]}>
        <ExplorePage />
      </MemoryRouter>,
    );
  const names = (container: HTMLElement) => [...container.querySelectorAll('.mg-island-info b')].map((element) => element.textContent);
  const more = (container: HTMLElement) => [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === '더 보기');

  it('처음에는 한 쪽만 부르고, 쪽이 모자라면 더 보기가 없다', async () => {
    list.mockResolvedValueOnce({ homes: page(3) });
    const { container, unmount } = await open();
    await flush();
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]?.[0]).toEqual({ limit: EXPLORE_PAGE, q: '' });
    expect(names(container)).toEqual(['섬0', '섬1', '섬2']);
    expect(more(container)).toBeUndefined();
    await unmount();
  });

  it('쪽이 가득 차면 더 보기로 마지막 섬의 시각 뒤를 이어 붙인다', async () => {
    const first = page(EXPLORE_PAGE);
    list.mockResolvedValueOnce({ homes: first });
    const { container, unmount } = await open();
    await flush();
    expect(more(container)).toBeDefined();

    list.mockResolvedValueOnce({ homes: [home(EXPLORE_PAGE), home(EXPLORE_PAGE + 1)] });
    await act(async () => more(container)!.click());
    await flush();
    expect(list.mock.calls[1]?.[0]).toEqual({ limit: EXPLORE_PAGE, q: '', before: first[EXPLORE_PAGE - 1]?.updatedAt });
    expect(names(container)).toHaveLength(EXPLORE_PAGE + 2);
    expect(names(container).at(-1)).toBe(`섬${EXPLORE_PAGE + 1}`);
    // 둘째 쪽이 모자랐으니 끝이다.
    expect(more(container)).toBeUndefined();
    await unmount();
  });

  it('검색어는 타이핑이 잠시 멎은 뒤 서버에 묻고, 앞의 요청은 끊는다', async () => {
    list.mockResolvedValue({ homes: page(2) });
    const { container, unmount } = await open();
    await flush();
    expect(list).toHaveBeenCalledTimes(1);

    const field = container.querySelector<HTMLInputElement>('input[type=search]')!;
    await type(field, '모');
    await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
    await type(field, '모개');
    await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[0]).toEqual({ limit: EXPLORE_PAGE, q: '모개' });
    expect(list.mock.calls[0]?.[1]?.aborted).toBe(true);
    await unmount();
  });

  it('주소의 검색어로 열면 처음부터 그 검색어로 묻는다', async () => {
    list.mockResolvedValue({ homes: [] });
    const { container, unmount } = await open('/explore?q=%EB%AA%A8%EA%B0%9C');
    await flush();
    expect(list.mock.calls[0]?.[0]).toEqual({ limit: EXPLORE_PAGE, q: '모개' });
    expect(container.textContent).toContain('찾는 섬이 없어요');
    await unmount();
  });

  it('검색이 바뀐 뒤 늦게 도착한 앞 검색의 더 보기는 새 목록에 붙지 않는다', async () => {
    list.mockResolvedValueOnce({ homes: page(EXPLORE_PAGE) });
    const { container, unmount } = await open();
    await flush();

    let late!: (result: { homes: HomeSummary[] }) => void;
    list.mockImplementationOnce(() => new Promise((done) => (late = done)));
    await act(async () => more(container)!.click());

    list.mockResolvedValueOnce({ homes: [home(900)] });
    await type(container.querySelector<HTMLInputElement>('input[type=search]')!, '새');
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    expect(names(container)).toEqual(['섬900']);

    late({ homes: [home(901)] });
    await flush();
    expect(names(container)).toEqual(['섬900']);
    await unmount();
  });

  it('새 검색의 첫 페이지를 기다리는 동안 이전 검색의 cursor를 제출하지 않는다', async () => {
    list.mockResolvedValueOnce({ homes: page(EXPLORE_PAGE) });
    const { container, unmount } = await open(); await flush();
    let answer!: (value: { homes: HomeSummary[] }) => void;
    list.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    await type(container.querySelector<HTMLInputElement>('input[type=search]')!, '새');
    expect(more(container)?.disabled).toBe(true);
    await act(async () => more(container)?.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(names(container)).toEqual([]); expect(more(container)).toBeUndefined();
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[0]).toEqual({ limit: EXPLORE_PAGE, q: '새' });
    answer({ homes: [home(900)] }); await flush();
    expect(names(container)).toEqual(['섬900']); await unmount();
  });

  it('같은 렌더 안의 연속 클릭도 더 보기 요청을 한 번만 보낸다', async () => {
    list.mockResolvedValueOnce({ homes: page(EXPLORE_PAGE) });
    const { container, unmount } = await open(); await flush();
    list.mockResolvedValueOnce({ homes: [home(900)] });
    await act(async () => { const button = more(container)!; button.click(); button.click(); });
    await flush(); expect(list).toHaveBeenCalledTimes(2); await unmount();
  });

  it('불러오지 못하면 알리고, 검색이 바뀐 뒤라면 이전 검색의 목록을 남겨 두지 않는다', async () => {
    list.mockResolvedValueOnce({ homes: page(2) });
    const { container, unmount } = await open();
    await flush();
    expect(names(container)).toHaveLength(2);

    list.mockRejectedValueOnce(new Error('offline'));
    await type(container.querySelector<HTMLInputElement>('input[type=search]')!, '모');
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    expect(container.textContent).toContain('목록을 불러오지 못했어요');
    expect(names(container)).toEqual([]);
    await unmount();
  });

  it('첫 쪽을 불러오지 못하면 알리고, 다시 불러오기로 같은 검색을 다시 묻는다', async () => {
    list.mockRejectedValueOnce(new Error('offline'));
    const { container, unmount } = await open('/explore?q=%EB%AA%A8');
    await flush();
    expect(container.querySelector('[role=alert]')?.textContent).toBe('목록을 불러오지 못했어요');
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === '다시 불러오기');
    expect(retry).toBeDefined();

    list.mockResolvedValueOnce({ homes: page(2) });
    await act(async () => retry!.click());
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[0]).toEqual({ limit: EXPLORE_PAGE, q: '모' });
    expect(names(container)).toEqual(['섬0', '섬1']);
    expect(container.querySelector('[role=alert]')).toBeNull();
    await unmount();
  });
});
