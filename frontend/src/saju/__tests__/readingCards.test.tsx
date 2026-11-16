import { act, useEffect, useRef, type ReactNode } from 'react';

import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../api/client';
import type { HomeView, SajuPictureState, SajuReading, SajuReadingState, SajuVillage, User } from '../../api/types';
import { mount } from '../../__tests__/mount';
import { readingChartOf } from '../readingChart';
import { personOf } from './people';

const { api, shots } = vi.hoisted(() => ({
  api: {
    mine: vi.fn(),
    get: vi.fn(),
    visit: vi.fn(),
    village: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    reading: vi.fn(),
    read: vi.fn(),
    picture: vi.fn(),
    draw: vi.fn(),
    ilchons: vi.fn(),
    requests: vi.fn(),
    status: vi.fn(),
  },
  /** How many times the island was drawn off the page. */
  shots: { count: 0 },
}));

// The canvas needs a graphics card: here it is one that has drawn its first frames, of the village it was given.
vi.mock('../scene/Stage', () => ({
  Stage: ({ pins, homes }: { pins?: ReactNode; homes: readonly { id: string }[] }) => (
    <div className="mg-saju-canvas" data-drawn={homes[0]?.id ?? ''}>
      {pins}
    </div>
  ),
}));
// The island drawn off the page: a canvas handed over once, as soon as it is mounted.
vi.mock('../scene/Snapshot', () => ({
  Snapshot: ({ onShot }: { onShot: (canvas: HTMLCanvasElement) => void }) => {
    const latest = useRef(onShot);
    latest.current = onShot;
    useEffect(() => {
      shots.count += 1;
      latest.current(document.createElement('canvas'));
    }, []);
    return null;
  },
}));
// The PDF is the report's: what the card hands it is what is looked at here.
vi.mock('../ui/SaveReport', () => ({
  SaveReport: ({ name, reading, pictureUrl }: { name: string; reading: SajuReading; pictureUrl: string | null }) => (
    <button className="report" data-name={name} data-summary={reading.saju.summary} data-picture={pictureUrl ?? ''}>
      PDF 저장
    </button>
  ),
}));
vi.mock('../../shell/Shell', () => ({
  PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Brand: () => <b className="brand">모개숲</b>,
  TopActions: ({ children }: { children?: ReactNode }) => <div className="top-actions">{children}</div>,
  initialOf: (name: string) => name.slice(0, 1),
  toneOf: () => '0',
  REQUESTS_CHANGED: 'mogaesup:requests',
}));
vi.mock('../../minihome/Guestbook', () => ({ Guestbook: () => <p className="guestbook" /> }));
vi.mock('../../api/endpoints', () => ({
  homeApi: { mine: api.mine, get: api.get, visit: api.visit },
  sajuApi: { village: api.village, save: api.save, remove: api.remove, reading: api.reading, read: api.read, picture: api.picture, draw: api.draw },
  socialApi: { ilchons: api.ilchons, requests: api.requests, status: api.status },
}));
let auth: { status: 'anonymous' | 'signedIn'; user: User | null } = { status: 'anonymous', user: null };
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => auth, useOptionalAuth: () => null }));

const { default: SajuPage } = await import('../SajuPage');

/** What the 2D canvas the picture is checked on holds: sixteen pixels a side. */
const pixels = new Uint8ClampedArray(16 * 16 * 4);

const sol: User = { id: 'u-sol', username: 'sol', displayName: '모개', role: 'user' };
const noeul: User = { id: 'u-noeul', username: 'noeul', displayName: '노을이', role: 'user' };
const view = (isOwner: boolean): HomeView => ({
  isOwner,
  visits: { today: 1, total: 1 },
  profile: { ownerId: 'u-sol', username: 'sol', ownerName: '모개', title: '', statusMessage: '', mood: 0, minime: 'man', emoji: '😊', visibility: 'public', updatedAt: '2026-11-01T00:00:00Z' },
});
const village = (birth = personOf('sol').birth): SajuVillage => ({ saju: { name: '솔', birth }, village: [] });

const written: SajuReading = {
  saju: {
    summary: '곧게 뻗는 나무의 사주예요.\n물이 그 뿌리를 적셔요.',
    sections: [
      { title: '성격', body: '앞으로 나아가요.' },
      { title: '일', body: '사람을 이끌어요.\n끝까지 해내요.' },
    ],
  },
  ziwei: { summary: '천부가 명궁을 지켜요.', sections: [{ title: '명궁', body: '든든해요.' }] },
};
const ready = (reading: SajuReading = written): SajuReadingState => ({ status: 'ready', model: 'gpt', createdAt: '2026-11-15T00:00:00Z', reading });
const pending = { status: 'pending', since: '2026-11-15T00:00:00Z' } as const;
const drawn = (url = '/models/abc.webp'): SajuPictureState => ({ status: 'ready', model: 'gpt-image', createdAt: '2026-11-15T00:00:00Z', url, width: 1024, height: 1024 });

function Page() {
  const { slug = '', '*': rest = '' } = useParams();
  return <SajuPage key={slug} username={slug.slice(1)} rest={rest} />;
}
/** Lets the clock run on, and what was waiting on it answer. */
const wait = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const open = async (path: string) => {
  const mounted = await mount(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:slug/*" element={<Page />} />
      </Routes>
    </MemoryRouter>,
  );
  await wait();
  return mounted;
};
const tab = (container: HTMLElement, label: string) => act(async () => [...container.querySelectorAll<HTMLAnchorElement>('.mg-saju-menu a')].find((anchor) => anchor.textContent === label)!.click());
const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label);
const card = (container: HTMLElement, label: string) => container.querySelector<HTMLElement>(`.mg-saju-side section[aria-label="${label}"]`);
const texts = (root: ParentNode | null, selector: string) => (root ? [...root.querySelectorAll(selector)].map((element) => element.textContent?.trim()) : []);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-11-15T12:00:00+09:00'));
  localStorage.clear();
  shots.count = 0;
  auth = { status: 'signedIn', user: sol };
  api.mine.mockResolvedValue(view(true));
  api.get.mockResolvedValue(view(false));
  api.visit.mockResolvedValue(null);
  api.village.mockImplementation(async (username: string) => (username === 'sol' ? village() : { saju: null, village: [] }));
  api.ilchons.mockResolvedValue({ ilchons: [] });
  api.requests.mockResolvedValue({ received: [], sent: [] });
  api.status.mockResolvedValue({ relation: 'none', ilchon: null, request: null });
  api.reading.mockResolvedValue({ status: 'none' });
  api.picture.mockResolvedValue({ status: 'none' });
  api.read.mockResolvedValue(pending);
  api.draw.mockResolvedValue(pending);
  // jsdom draws nothing: a 2D canvas that takes a picture (of more than one colour) and writes it as WebP.
  pixels.fill(0).forEach((_, index) => void (pixels[index] = index % 251));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({ drawImage: vi.fn(), imageSmoothingQuality: 'low', getImageData: () => ({ data: pixels }) }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation((type?: string) => `data:${type ?? 'image/png'};base64,AAAA`);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  localStorage.clear();
});

describe('사주 풀이 카드', () => {
  it('주인이 풀이 탭을 처음 열면 한 번만 청하고, 쓰는 동안 그렇다고 하다가 다 쓰면 요약과 절을 보여 준다', async () => {
    api.picture.mockResolvedValue(drawn());
    api.reading.mockResolvedValueOnce({ status: 'none' }).mockResolvedValueOnce(pending).mockResolvedValue(ready());
    const { container, unmount } = await open('/@sol');
    // 홈에서는 풀이를 읽지도 청하지도 않는다.
    expect(api.reading).not.toHaveBeenCalled();
    await tab(container, '사주보기');
    await wait();
    expect(api.read).toHaveBeenCalledExactlyOnceWith({ expectedOwnerId: 'u-sol', chart: readingChartOf(personOf('sol').birth) });
    // 풀이 카드가 사주 원국보다 먼저 선다.
    expect(container.querySelector('.mg-saju-chart > section')?.getAttribute('aria-label')).toBe('사주 풀이');
    const writing = card(container, '사주 풀이')!;
    expect(writing.getAttribute('aria-busy')).toBe('true');
    expect(texts(writing, '[role=status]')).toEqual(['풀이를 쓰고 있어요']);
    expect(writing.querySelector('.mg-progress')).not.toBeNull();
    // 몇 초마다 다시 보고, 갈수록 뜸하게 본다.
    await wait(2_900);
    expect(api.reading).toHaveBeenCalledTimes(1);
    await wait(100);
    expect(api.reading).toHaveBeenCalledTimes(2);
    expect(card(container, '사주 풀이')?.getAttribute('aria-busy')).toBe('true');
    await wait(4_400);
    expect(api.reading).toHaveBeenCalledTimes(2);
    await wait(100);
    expect(api.reading).toHaveBeenCalledTimes(3);
    const done = card(container, '사주 풀이')!;
    expect(done.getAttribute('aria-busy')).toBeNull();
    expect(texts(done, '.mg-saju-reading-summary p')).toEqual(['곧게 뻗는 나무의 사주예요.', '물이 그 뿌리를 적셔요.']);
    expect(texts(done, '.mg-saju-reading-part h3')).toEqual(['성격', '일']);
    expect(texts(done, '.mg-saju-reading-part p')).toEqual(['앞으로 나아가요.', '사람을 이끌어요.', '끝까지 해내요.']);
    // 머리에는 PDF 저장(그림과 함께)과 주인의 다시 풀기가 있다.
    const report = done.querySelector<HTMLElement>('.mg-saju-reading-head .report')!;
    expect([report.dataset['name'], report.dataset['summary'], report.dataset['picture']]).toEqual(['솔', written.saju.summary, '/models/abc.webp']);
    expect(texts(done, '.mg-saju-reading-head button')).toEqual(['PDF 저장', '다시 풀기']);
    // 다 쓴 뒤에는 더 보지 않는다.
    await wait(60_000);
    expect(api.reading).toHaveBeenCalledTimes(3);

    // 자미두수 탭에는 명반의 풀이가 명반 위에 있고, 다시 청하지 않는다.
    await tab(container, '자미두수');
    await wait();
    const ziwei = card(container, '자미두수 풀이')!;
    expect(container.querySelector('.mg-ziwei > section')).toBe(ziwei);
    expect(texts(ziwei, '.mg-saju-reading-summary p')).toEqual(['천부가 명궁을 지켜요.']);
    expect(texts(ziwei, '.mg-saju-reading-head button')).toEqual(['PDF 저장', '다시 풀기']);
    await tab(container, '사주보기');
    await wait();
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(api.reading).toHaveBeenCalledTimes(3);
    await unmount();
  });

  it('자미두수 탭에서 먼저 열어도 한 번만 청하고, 다 쓴 풀이가 있으면 청하지 않는다', async () => {
    const first = await open('/@sol?view=ziwei');
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(texts(card(first.container, '자미두수 풀이'), '[role=status]')).toEqual(['풀이를 쓰고 있어요']);
    await tab(first.container, '사주보기');
    await wait();
    expect(api.read).toHaveBeenCalledTimes(1);
    await first.unmount();

    api.read.mockClear();
    api.reading.mockResolvedValue(ready());
    const again = await open('/@sol?view=chart');
    expect(api.read).not.toHaveBeenCalled();
    expect(card(again.container, '사주 풀이')?.querySelector('.mg-saju-reading-summary')).not.toBeNull();
    await again.unmount();
  });

  it('쓰는 동안 탭을 떠나면 더 보지 않고, 돌아오면 다시 본다', async () => {
    api.reading.mockResolvedValueOnce({ status: 'none' }).mockResolvedValue(pending);
    const { container, unmount } = await open('/@sol?view=chart');
    await tab(container, '홈');
    await wait(60_000);
    expect(api.reading).toHaveBeenCalledTimes(1);
    await tab(container, '사주보기');
    await wait(3_000);
    expect(api.reading).toHaveBeenCalledTimes(2);
    expect(api.read).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('십 분이 지나도 쓰고 있으면 그만 보고, 끝내지 못했다고 하며 다시 시도하게 한다', async () => {
    api.reading.mockResolvedValueOnce({ status: 'none' }).mockResolvedValue(pending);
    const { container, unmount } = await open('/@sol?view=chart');
    await wait(10 * 60_000 + 20_000);
    const calls = api.reading.mock.calls.length;
    expect(texts(card(container, '사주 풀이'), '[role=alert]')).toEqual(['풀이를 끝내지 못했어요']);
    await wait(5 * 60_000);
    expect(api.reading).toHaveBeenCalledTimes(calls);
    await act(async () => button(card(container, '사주 풀이')!, '다시 시도')!.click());
    await wait();
    expect(api.read).toHaveBeenCalledTimes(2);
    expect(api.read.mock.calls[1]?.[0]).not.toHaveProperty('again');
    await unmount();
  });

  it('주인은 다시 풀기로 새 풀이를 청하고, 한도를 넘으면 서버의 말을 보여 주며 쓴 풀이는 남는다', async () => {
    api.reading.mockResolvedValue(ready());
    api.read.mockRejectedValueOnce(new ApiRequestError(429, 'too_many', '풀이는 하루에 세 번까지 다시 받을 수 있어요.'));
    const { container, unmount } = await open('/@sol?view=chart');
    await act(async () => button(card(container, '사주 풀이')!, '다시 풀기')!.click());
    await wait();
    expect(api.read).toHaveBeenCalledExactlyOnceWith({ expectedOwnerId: 'u-sol', chart: readingChartOf(personOf('sol').birth), again: true });
    const refused = card(container, '사주 풀이')!;
    expect(texts(refused, '[role=alert]')).toEqual(['풀이는 하루에 세 번까지 다시 받을 수 있어요.']);
    expect(texts(refused, '.mg-saju-reading-summary p')).toHaveLength(2);
    // 받아들여지면 새 풀이를 쓰는 동안이 된다.
    await act(async () => button(card(container, '사주 풀이')!, '다시 풀기')!.click());
    await wait();
    expect(texts(card(container, '사주 풀이'), '[role=status]')).toEqual(['풀이를 쓰고 있어요']);
    await unmount();
  });

  it('쓰지 못한 풀이는 그 까닭과 다시 시도가 있고, 서버가 지금 쓰지 않을 때(키 없음·예산 소진)는 카드가 없다', async () => {
    api.reading.mockResolvedValue({ status: 'failed', code: 'provider_error', message: '풀이를 쓰지 못했어요. 다시 시도해 주세요.' });
    const failed = await open('/@sol?view=chart');
    expect(api.read).not.toHaveBeenCalled();
    expect(texts(card(failed.container, '사주 풀이'), '[role=alert]')).toEqual(['풀이를 쓰지 못했어요. 다시 시도해 주세요.']);
    await act(async () => button(card(failed.container, '사주 풀이')!, '다시 시도')!.click());
    await wait();
    expect(api.read).toHaveBeenCalledExactlyOnceWith({ expectedOwnerId: 'u-sol', chart: readingChartOf(personOf('sol').birth) });
    expect(texts(card(failed.container, '사주 풀이'), '[role=status]')).toEqual(['풀이를 쓰고 있어요']);
    await failed.unmount();

    api.reading.mockResolvedValue({ status: 'none' });
    api.read.mockReset().mockRejectedValue(new ApiRequestError(503, 'reading_unavailable', '지금은 풀이를 쓸 수 없어요.'));
    const closed = await open('/@sol?view=chart');
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(card(closed.container, '사주 풀이')).toBeFalsy();
    // 저절로 다시 청하지 않는다.
    await tab(closed.container, '자미두수');
    await wait(60_000);
    expect(api.read).toHaveBeenCalledTimes(1);
    await closed.unmount();
  });

  it('손님은 다 쓴 풀이만 보고, PDF는 저장할 수 있으며, 청하지도 다시 보지도 않는다', async () => {
    auth = { status: 'signedIn', user: noeul };
    api.reading.mockResolvedValue(ready());
    const visit = await open('/@sol?view=chart');
    const shown = card(visit.container, '사주 풀이')!;
    expect(texts(shown, '.mg-saju-reading-head button')).toEqual(['PDF 저장']);
    expect(shown.querySelector<HTMLElement>('.report')?.dataset['picture']).toBe('');
    await visit.unmount();

    for (const state of [pending, { status: 'failed', code: 'provider_error', message: '쓰지 못했어요' }, { status: 'none' }] as SajuReadingState[]) {
      api.reading.mockReset().mockResolvedValue(state);
      const { container, unmount } = await open('/@sol?view=chart');
      expect(card(container, '사주 풀이')).toBeNull();
      expect(container.querySelector('.mg-saju-chart > section')?.getAttribute('aria-label')).toBe('사주 원국');
      await wait(60_000);
      expect(api.reading).toHaveBeenCalledTimes(1);
      await unmount();
    }
    expect(api.read).not.toHaveBeenCalled();
    auth = { status: 'anonymous', user: null };
    api.reading.mockReset().mockResolvedValue(ready());
    const outside = await open('/@sol?view=ziwei');
    expect(texts(card(outside.container, '자미두수 풀이'), '.mg-saju-reading-summary p')).toEqual(['천부가 명궁을 지켜요.']);
    await outside.unmount();
  });

  it('시를 모르는 집에는 자미두수 풀이가 없다', async () => {
    api.village.mockResolvedValue(village({ ...personOf('sol').birth, time: null }));
    api.reading.mockResolvedValue(ready({ ...written, ziwei: null }));
    const { container, unmount } = await open('/@sol?view=ziwei');
    expect(card(container, '자미두수 풀이')).toBeNull();
    expect(container.querySelector('.mg-ziwei-none')).not.toBeNull();
    await tab(container, '사주보기');
    await wait();
    expect(card(container, '사주 풀이')).not.toBeNull();
    await unmount();
  });
});

describe('섬 그림 카드', () => {
  it('주인의 섬이 다 그려지면 섬만 한 번 그려 보내고, 그리는 동안 그렇다고 하다가 그림을 보여 준다', async () => {
    api.picture.mockResolvedValueOnce({ status: 'none' }).mockResolvedValueOnce(pending).mockResolvedValue(drawn('/models/island.webp'));
    const { container, unmount } = await open('/@sol');
    expect(shots.count).toBe(0);
    // 섬이 자리를 잡고 나서 그린다.
    await wait(1_500);
    expect(shots.count).toBe(1);
    expect(api.draw).toHaveBeenCalledExactlyOnceWith({ expectedOwnerId: 'u-sol', image: 'data:image/webp;base64,AAAA' });
    // 오행 밸런스 위, 사주 요약 아래에 선다.
    expect([...container.querySelectorAll('.mg-saju-side > section')].map((section) => section.getAttribute('aria-label')).slice(0, 3)).toEqual(['사주 요약', '섬 그림', '오행 밸런스']);
    const drawing = card(container, '섬 그림')!;
    expect(drawing.getAttribute('aria-busy')).toBe('true');
    expect(texts(drawing, '[role=status]')).toEqual(['그림을 그리고 있어요']);
    await wait(3_000);
    expect(card(container, '섬 그림')?.getAttribute('aria-busy')).toBe('true');
    await wait(4_500);
    const picture = card(container, '섬 그림')!;
    expect(picture.querySelector('img')?.getAttribute('src')).toBe('/models/island.webp');
    // 다른 탭에 갔다 와도 다시 그리지 않는다.
    await tab(container, '마을');
    await tab(container, '홈');
    await wait(60_000);
    expect(shots.count).toBe(1);
    expect(api.draw).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('서버가 지금은 그릴 수 없다고 하면 섬을 다시 그리지도 보내지도 않고 카드도 없다', async () => {
    api.picture.mockResolvedValue({ status: 'none', off: true });
    api.reading.mockResolvedValue({ status: 'none', off: true });
    const { container, unmount } = await open('/@sol');
    await wait(1_500);
    await wait(10_000);
    expect(shots.count).toBe(0);
    expect(api.draw).not.toHaveBeenCalled();
    expect(card(container, '섬 그림')).toBeNull();
    // 풀이 탭을 열어도 청하지 않는다.
    await tab(container, '사주보기');
    await wait();
    expect(api.read).not.toHaveBeenCalled();
    expect(card(container, '사주 풀이')).toBeNull();
    await unmount();
  });

  it('그림을 누르면 크게 열리고, Esc로 닫으면 누른 그림으로 돌아간다', async () => {
    api.picture.mockResolvedValue(drawn('/models/island.webp'));
    const { container, unmount } = await open('/@sol');
    const opener = card(container, '섬 그림')!.querySelector<HTMLButtonElement>('.mg-saju-picture-open')!;
    expect(opener.getAttribute('aria-label')).toBe('솔의 섬 그림 크게 보기');
    opener.focus();
    await act(async () => opener.click());
    const dialog = document.querySelector<HTMLElement>('[role=dialog][aria-modal=true]')!;
    expect(dialog.getAttribute('aria-label')).toBe('솔의 섬 그림');
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('/models/island.webp');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('닫기');
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    // 닫기 단추로도 닫는다.
    await act(async () => opener.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[role=dialog] [aria-label="닫기"]')!.click());
    expect(document.querySelector('[role=dialog]')).toBeNull();
    // 그림이 다 그려져 있으면 새로 그리지 않고, 주인은 다시 그릴 수 있다.
    await wait(60_000);
    expect(shots.count).toBe(0);
    expect(texts(card(container, '섬 그림'), 'button.mg-saju-picture-again')).toEqual(['다시 그리기']);
    await unmount();
  });

  it('다시 그리기는 섬을 새로 그려 again으로 보내고, 한도를 넘으면 그 말을 보여 주며 그림은 남는다', async () => {
    api.picture.mockResolvedValue(drawn());
    api.draw.mockRejectedValueOnce(new ApiRequestError(429, 'too_many', '그림은 한 달에 두 번까지 다시 그릴 수 있어요.'));
    const { container, unmount } = await open('/@sol');
    await act(async () => button(card(container, '섬 그림')!, '다시 그리기')!.click());
    await wait();
    expect(shots.count).toBe(1);
    expect(api.draw).toHaveBeenCalledExactlyOnceWith({ expectedOwnerId: 'u-sol', image: 'data:image/webp;base64,AAAA', again: true });
    const refused = card(container, '섬 그림')!;
    expect(texts(refused, '[role=alert]')).toEqual(['그림은 한 달에 두 번까지 다시 그릴 수 있어요.']);
    expect(refused.querySelector('img')).not.toBeNull();
    await unmount();
  });

  it('WebP를 쓰지 못하는 브라우저는 JPEG로 보낸다', async () => {
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementation((type?: string) => (type === 'image/jpeg' ? 'data:image/jpeg;base64,BBBB' : 'data:image/png;base64,CCCC'));
    const { unmount } = await open('/@sol');
    await wait(1_500);
    expect(api.draw).toHaveBeenCalledExactlyOnceWith({ expectedOwnerId: 'u-sol', image: 'data:image/jpeg;base64,BBBB' });
    await unmount();
  });

  it('그리지 못한 그림은 그 까닭과 다시 시도가 있고, 다시 시도는 again 없이 보낸다', async () => {
    api.picture.mockResolvedValue({ status: 'failed', code: 'interrupted', message: '그림을 끝내지 못했어요' });
    const { container, unmount } = await open('/@sol');
    await wait(1_500);
    expect(shots.count).toBe(0);
    expect(texts(card(container, '섬 그림'), '[role=alert]')).toEqual(['그림을 끝내지 못했어요']);
    await act(async () => button(card(container, '섬 그림')!, '다시 시도')!.click());
    await wait();
    expect(shots.count).toBe(1);
    expect(api.draw).toHaveBeenCalledExactlyOnceWith({ expectedOwnerId: 'u-sol', image: 'data:image/webp;base64,AAAA' });
    expect(texts(card(container, '섬 그림'), '[role=status]')).toEqual(['그림을 그리고 있어요']);
    await unmount();
  });

  it('섬을 그리지 못하면 그렇다고 하고, 보내지 않는다', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const { container, unmount } = await open('/@sol');
    await wait(1_500);
    expect(api.draw).not.toHaveBeenCalled();
    expect(texts(card(container, '섬 그림'), '[role=alert]')).toEqual(['이미지를 만들지 못했어요']);
    await unmount();
  });

  it('한 가지 색뿐인 그림은 아무것도 그려지지 않은 것이라 보내지 않는다', async () => {
    // 그래픽 카드가 그리지 못한 캔버스: 온통 검다.
    pixels.fill(0);
    for (let index = 3; index < pixels.length; index += 4) pixels[index] = 255;
    const { container, unmount } = await open('/@sol');
    await wait(1_500);
    expect(shots.count).toBe(1);
    expect(api.draw).not.toHaveBeenCalled();
    expect(texts(card(container, '섬 그림'), '[role=alert]')).toEqual(['이미지를 만들지 못했어요']);
    // 다시 시도는 섬을 다시 그린다.
    pixels.forEach((_, index) => void (pixels[index] = index % 251));
    await act(async () => button(card(container, '섬 그림')!, '다시 시도')!.click());
    await wait();
    expect(shots.count).toBe(2);
    expect(api.draw).toHaveBeenCalledExactlyOnceWith({ expectedOwnerId: 'u-sol', image: 'data:image/webp;base64,AAAA' });
    await unmount();
  });

  it('사주를 다시 입력하는 동안에는 그리지 않는다', async () => {
    const { unmount } = await open('/@sol/edit');
    await wait(60_000);
    expect(shots.count).toBe(0);
    expect(api.draw).not.toHaveBeenCalled();
    await unmount();
  });

  it('손님은 다 그린 그림만 보고, 그리지도 다시 보지도 않는다', async () => {
    auth = { status: 'signedIn', user: noeul };
    api.picture.mockResolvedValue(drawn('/models/island.webp'));
    const visit = await open('/@sol');
    const shown = card(visit.container, '섬 그림')!;
    expect(shown.querySelector('img')?.getAttribute('src')).toBe('/models/island.webp');
    expect(texts(shown, 'button.mg-saju-picture-again')).toEqual([]);
    await visit.unmount();
    for (const state of [pending, { status: 'failed', code: 'provider_error', message: '그리지 못했어요' }, { status: 'none' }] as SajuPictureState[]) {
      api.picture.mockReset().mockResolvedValue(state);
      const { container, unmount } = await open('/@sol');
      await wait(60_000);
      expect(card(container, '섬 그림')).toBeNull();
      expect(api.picture).toHaveBeenCalledTimes(1);
      await unmount();
    }
    expect(shots.count).toBe(0);
    expect(api.draw).not.toHaveBeenCalled();
  });
});
