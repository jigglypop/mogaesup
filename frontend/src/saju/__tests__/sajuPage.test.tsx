import { act, useImperativeHandle, type ReactNode, type Ref } from 'react';

import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../api/client';
import type { HomeView, Ilchon, IlchonStatus, SajuVillage, User } from '../../api/types';
import { mount, type } from '../../__tests__/mount';
import type { StageFlag } from '../scene/Flag';
import { frameOf, type Frame, type Inset } from '../scene/frames';
import type { StageBridge, StageHandle, StageHome } from '../scene/Stage';
import { FLAG_SPOT, PLOT_REACH } from '../village';
import { personOf } from './people';

type StageProps = { ref?: Ref<StageHandle>; homes: StageHome[]; bridges: StageBridge[]; frame: Frame; inset?: Inset; flag?: StageFlag | null; focus: string | null; onVisit: (id: string) => void; pins?: ReactNode };
const { stage, api } = vi.hoisted(() => ({
  stage: { props: null as StageProps | null, zooms: [] as number[] },
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
    decor: vi.fn(),
    placeDecor: vi.fn(),
    giveFlag: vi.fn(),
    dropFlag: vi.fn(),
    ilchons: vi.fn(),
    requests: vi.fn(),
    status: vi.fn(),
  },
}));

// The canvas needs WebGL; the page around it is what is looked at here.
vi.mock('../scene/Stage', () => ({
  Stage: (props: StageProps) => {
    stage.props = props;
    useImperativeHandle(props.ref, () => ({ zoomBy: (factor: number) => void stage.zooms.push(factor) }), []);
    return <div className="stage">{props.pins}</div>;
  },
}));
vi.mock('../scene/Snapshot', () => ({ Snapshot: () => null }));
vi.mock('../../shell/Shell', () => ({
  PageShell: ({ title, children }: { title: ReactNode; children: ReactNode }) => <div data-shell={String(title)}>{children}</div>,
  Brand: () => <b className="brand">모개숲</b>,
  TopActions: ({ children }: { children?: ReactNode }) => <div className="top-actions">{children}</div>,
  initialOf: (name: string) => name.slice(0, 1),
  toneOf: () => '0',
  REQUESTS_CHANGED: 'mogaesup:requests',
}));
vi.mock('../../minihome/Guestbook', () => ({ Guestbook: ({ username }: { username: string }) => <p className="guestbook">{username}</p> }));
vi.mock('../../api/endpoints', () => ({
  homeApi: { mine: api.mine, get: api.get, visit: api.visit },
  sajuApi: { village: api.village, save: api.save, remove: api.remove, reading: api.reading, read: api.read, picture: api.picture, draw: api.draw, decor: api.decor, placeDecor: api.placeDecor, giveFlag: api.giveFlag, dropFlag: api.dropFlag },
  socialApi: { ilchons: api.ilchons, requests: api.requests, status: api.status },
}));
let auth: { status: 'anonymous' | 'signedIn'; user: User | null } = { status: 'anonymous', user: null };
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => auth, useOptionalAuth: () => null }));

const { default: SajuPage } = await import('../SajuPage');

const sol: User = { id: 'u-sol', username: 'sol', displayName: '모개', role: 'user' };
const noeul: User = { id: 'u-noeul', username: 'noeul', displayName: '노을이', role: 'user' };
const home = (id: string) => ({ name: personOf(id).name, birth: personOf(id).birth });
const around = (id: string, neighbour: boolean) => ({ user: { id: `u-${id}`, username: id, displayName: personOf(id).name, emoji: '😊' }, saju: home(id), neighbour });
const view = (isOwner: boolean): HomeView => ({
  isOwner,
  visits: { today: 3, total: 12 },
  profile: { ownerId: 'u-sol', username: 'sol', ownerName: '모개', title: '', statusMessage: '', mood: 0, minime: 'man', emoji: '😊', visibility: 'public', updatedAt: '2026-11-01T00:00:00Z' },
});
const standing = (relation: IlchonStatus['relation']): IlchonStatus => ({
  relation,
  ilchon: relation === 'ilchon' ? { user: { id: 'u-sol', username: 'sol', displayName: '모개', emoji: '😊' }, name: '옆집', theirName: '앞집', since: '2026-11-01T00:00:00Z' } : null,
  request: null,
});
const ilchons = (count: number): Ilchon[] =>
  Array.from({ length: count }, (_, index) => ({ user: { id: `u-n${index}`, username: `n${index}`, displayName: `이웃${index}`, emoji: '😊' }, name: '이웃', theirName: '이웃', since: '2026-11-01T00:00:00Z' }));

function Page() {
  const { slug = '', '*': rest = '' } = useParams();
  return <SajuPage key={slug} username={slug.slice(1)} rest={rest} />;
}
function Where() {
  const { pathname, search } = useLocation();
  return <output>{pathname + search}</output>;
}
const settle = () => act(async () => { for (let round = 0; round < 5; round++) await new Promise((done) => setTimeout(done, 0)); });
/** The frame of the 섬's own home alone, close up: what its home shows. */
const alone = () => frameOf([stage.props!.homes[0]!]);

describe('섬 화면', () => {
  /** What the server holds: each member's village by username. */
  let villages: Record<string, SajuVillage>;

  beforeEach(() => {
    localStorage.clear();
    stage.props = null;
    stage.zooms = [];
    api.decor.mockResolvedValue({ items: [], flags: [], character: null });
    auth = { status: 'signedIn', user: sol };
    villages = { sol: { saju: home('sol'), village: [around('noeul', true), around('bori', false)] }, noeul: { saju: home('noeul'), village: [around('sol', true)] } };
    api.mine.mockImplementation(async () => view(true));
    api.get.mockImplementation(async () => view(false));
    api.visit.mockResolvedValue(null);
    api.village.mockImplementation(async (username: string) => villages[username] ?? { saju: null, village: [] });
    api.ilchons.mockResolvedValue({ ilchons: [] });
    api.requests.mockResolvedValue({ received: [], sent: [] });
    api.status.mockResolvedValue(standing('none'));
    // Nothing written or drawn yet; asked for, it is on its way (readingCards.test.tsx follows it further).
    api.reading.mockResolvedValue({ status: 'none' });
    api.picture.mockResolvedValue({ status: 'none' });
    api.read.mockResolvedValue({ status: 'pending', since: '2026-11-15T00:00:00Z' });
    api.draw.mockResolvedValue({ status: 'pending', since: '2026-11-15T00:00:00Z' });
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  const open = async (path: string) => {
    const mounted = await mount(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/:slug/*" element={<Page />} />
        </Routes>
        <Where />
      </MemoryRouter>,
    );
    await settle();
    return mounted;
  };
  const where = (container: HTMLElement) => container.querySelector('output')!.textContent;
  const link = (container: HTMLElement, label: string) => [...container.querySelectorAll('a')].find((anchor) => anchor.textContent?.trim() === label);
  const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  const field = (container: HTMLElement, name: string) => container.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
  const menu = (container: HTMLElement) =>
    [...container.querySelectorAll('.mg-saju-menu a')].map((anchor) => `${anchor.textContent}${anchor.getAttribute('aria-current') ? '*' : ''} ${anchor.getAttribute('href')}`);
  const pins = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLAnchorElement>('.mg-saju-pin')].map((pin) => `${pin.dataset['pin']} ${pin.getAttribute('href')} ${pin.textContent}`);

  it('집을 짓기 전의 주인에게는 마을 지도와 집 짓는 카드가 있다', async () => {
    villages['sol'] = { saju: null, village: [around('noeul', false), around('bori', false)] };
    const { container, unmount } = await open('/@sol');
    // 캔버스가 창을 채우고, 앱의 머리띠가 그 위에 뜬다. 레일은 없다: 상표가 처음으로 간다.
    expect(container.querySelector('.mg-saju-world > .mg-saju-stage .stage')).not.toBeNull();
    expect(container.querySelector('.mg-saju-world > .mg-topbar .brand')).not.toBeNull();
    // 키보드와 화면 낭독기에게도 머리띠가 먼저고, 그림 위의 이름표는 그 뒤다.
    expect(container.querySelector('.mg-saju-world')?.firstElementChild?.classList.contains('mg-topbar')).toBe(true);
    expect(container.querySelector('.mg-rail, nav[aria-label="모개숲"]')).toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe('모개의 섬');
    expect(container.querySelector('.mg-saju-visits')?.textContent).toBe('오늘 3 · 전체 12');
    expect(container.querySelector('.mg-saju-form h2')?.textContent).toBe('내 집 짓기');
    // 로그인한 이름을 미리 적어 둔다.
    expect(field(container, 'name').value).toBe('모개');
    // 가운데는 빈 터다. 화(火)의 집은 남쪽에 서고, 제 방위가 없는 토(土)의 집은 남은 첫 자리에 든다.
    expect(stage.props?.homes.map((item) => [item.id, item.x, item.z, !!item.profile])).toEqual([
      ['sol', 0, 0, false],
      ['bori', PLOT_REACH, 0, true],
      ['noeul', 0, PLOT_REACH, true],
    ]);
    expect(stage.props?.focus).toBeNull();
    expect(stage.props?.bridges).toEqual([]);
    expect(pins(container)).toEqual(['sol /@sol 빈 터내 집 짓기', 'bori /@bori 보리', 'noeul /@noeul 노을']);
    // 지은 집이 없으니 사주보기도 없다.
    expect(menu(container)).toEqual(['홈* /@sol', '마을 /@sol/village']);
    // 짓기 전에도 제 방명록을 읽고, 누가 놀러 올지 정할 수 있다. 빈 터라는 말은 손님에게만 한다.
    expect(container.querySelector('.guestbook')?.textContent).toBe('sol');
    expect(container.querySelector('[aria-label="공개 범위"]')).not.toBeNull();
    expect(container.querySelector('.mg-saju-badge')).toBeNull();
    await unmount();
  });

  it('카드를 채워 내면 서버에 집을 짓고 그 집을 보여 준다', async () => {
    villages['sol'] = { saju: null, village: [] };
    api.save.mockImplementation(async ({ name, birth }: { name: string; birth: SajuVillage['village'][number]['saju']['birth'] }) => ({ saju: { name, birth } }));
    const { container, unmount } = await open('/@sol');
    await type(field(container, 'year'), '1989');
    await type(field(container, 'month'), '2');
    await type(field(container, 'day'), '23');
    await type(field(container, 'time'), '22:10');
    await act(async () => button(container, '여성')!.click());
    await act(async () => container.querySelector('form')!.requestSubmit());
    await settle();
    expect(api.save).toHaveBeenCalledExactlyOnceWith({ expectedOwnerId: 'u-sol', name: '모개', birth: personOf('sol').birth });
    expect(container.querySelector('.mg-saju-form')).toBeNull();
    expect(container.querySelector('.mg-saju-badge')?.textContent).toBe('곧게 뻗는 큰 나무 같은 갑목(甲木) 일간');
    expect(stage.props?.focus).toBe('sol');
    expect(menu(container)).toEqual(['홈* /@sol', '사주보기 /@sol?view=chart', '자미두수 /@sol?view=ziwei', '마을 /@sol/village']);
    await unmount();
  });

  it('이 브라우저에 남아 있던 집으로 카드를 채우고, 서버에 지으면 그 기록을 지운다', async () => {
    villages['sol'] = { saju: null, village: [] };
    localStorage.setItem('saju:village', JSON.stringify({ me: { name: '가온', birth: personOf('garam').birth }, entries: [], bridges: [] }));
    api.save.mockImplementation(async ({ name, birth }: { name: string; birth: unknown }) => ({ saju: { name, birth } }));
    const { container, unmount } = await open('/@sol');
    expect(field(container, 'name').value).toBe('가온');
    expect(field(container, 'year').value).toBe('1992');
    await act(async () => container.querySelector('form')!.requestSubmit());
    await settle();
    expect(api.save).toHaveBeenCalledExactlyOnceWith({ expectedOwnerId: 'u-sol', name: '가온', birth: personOf('garam').birth });
    expect(localStorage.getItem('saju:village')).toBeNull();
    await unmount();
  });

  it('내 집은 집만 가까이 보여 주고, 사주 다시 입력과 이미지 저장이 있다', async () => {
    const { container, unmount } = await open('/@sol');
    expect(container.querySelector('h1')?.textContent).toBe('솔의 섬');
    expect(stage.props?.focus).toBe('sol');
    expect(stage.props?.frame).toEqual(alone());
    expect(stage.props?.frame.target).toEqual([0, 1.5, 0]);
    expect(pins(container)).toEqual([]);
    expect(link(container, '사주 다시 입력')?.getAttribute('href')).toBe('/@sol/edit');
    expect(button(container, '내 집 이미지 저장하기')).toBeDefined();
    expect(container.querySelector('.guestbook')?.textContent).toBe('sol');
    // 다리는 이웃의 집으로만 놓인다.
    expect(stage.props?.bridges.map((bridge) => [bridge.from.id, bridge.to.id, bridge.compat.tone])).toEqual([['sol', 'noeul', 'flow']]);
    // 내 집으로 가는 단추는 남의 집에만 있고, 파도타기는 둘레의 집으로 간다.
    expect(link(container, '내 집')).toBeUndefined();
    expect(link(container, '파도타기')?.getAttribute('href')).toBe('/@noeul');
    await unmount();
  });

  it('사주보기와 마을은 같은 틀 안에서 열린다', async () => {
    const chart = await open('/@sol?view=chart');
    expect(menu(chart.container)).toEqual(['홈 /@sol', '사주보기* /@sol?view=chart', '자미두수 /@sol?view=ziwei', '마을 /@sol/village']);
    expect(chart.container.querySelector('.mg-saju-pillars')).not.toBeNull();
    expect(chart.container.querySelector('.guestbook')).toBeNull();
    await chart.unmount();

    const village = await open('/@sol/village');
    expect(menu(village.container)).toEqual(['홈 /@sol', '사주보기 /@sol?view=chart', '자미두수 /@sol?view=ziwei', '마을* /@sol/village']);
    expect(stage.props?.focus).toBeNull();
    expect(stage.props!.frame.halfWidth).toBeGreaterThan(alone().halfWidth);
    expect(pins(village.container)).toEqual(['sol /@sol 솔내 집', 'bori /@bori 보리', 'noeul /@noeul 노을']);
    expect([...village.container.querySelectorAll('a.mg-saju-villager b')].map((name) => name.textContent)).toEqual(['솔내 집', '노을이웃', '보리']);
    expect(village.container.querySelector('.mg-neighbors')).not.toBeNull();
    await village.unmount();
  });

  it('사주를 다시 입력하면 서버의 집을 다시 짓고 집으로 돌아간다', async () => {
    api.save.mockImplementation(async ({ name, birth }: { name: string; birth: unknown }) => ({ saju: { name, birth } }));
    const { container, unmount } = await open('/@sol/edit');
    expect(container.querySelector('.mg-saju-form h2')?.textContent).toBe('사주 다시 입력');
    expect(field(container, 'year').value).toBe('1989');
    // 다시 입력하는 쪽에는 카드만 있다.
    expect(container.querySelector('.guestbook')).toBeNull();
    await type(field(container, 'name'), '솔이');
    await act(async () => field(container, 'noTime').click());
    await act(async () => container.querySelector('form')!.requestSubmit());
    await settle();
    expect(api.save).toHaveBeenCalledExactlyOnceWith({ expectedOwnerId: 'u-sol', name: '솔이', birth: { ...personOf('sol').birth, time: null } });
    expect(where(container)).toBe('/@sol');
    expect(container.querySelector('h1')?.textContent).toBe('솔이의 섬');
    await unmount();
  });

  it('집을 허물면 빈 터와 집 짓는 카드로 돌아간다', async () => {
    api.remove.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container, unmount } = await open('/@sol/edit');
    await act(async () => button(container, '집 허물기')!.click());
    await settle();
    expect(api.remove).toHaveBeenCalledExactlyOnceWith({ expectedOwnerId: 'u-sol' });
    expect(where(container)).toBe('/@sol');
    const form = container.querySelector('.mg-saju-form')!;
    expect(form.querySelector('h2')?.textContent).toBe('내 집 짓기');
    // 새 카드다: 보내던 것이 남아 잠겨 있지 않다.
    expect(form.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(false);
    await unmount();
  });

  it('이웃인 손님은 궁합을 보고, 제 집과 그 집을 다리와 함께 본다', async () => {
    auth = { status: 'signedIn', user: noeul };
    api.status.mockResolvedValue(standing('ilchon'));
    const { container, unmount } = await open('/@sol');
    expect(api.get).toHaveBeenCalledExactlyOnceWith('sol');
    expect(link(container, '내 집')?.getAttribute('href')).toBe('/@noeul');
    // 파도타기는 내 집이 아닌 집으로 간다.
    expect(link(container, '파도타기')?.getAttribute('href')).toBe('/@bori');
    expect(link(container, '사주 다시 입력')).toBeUndefined();
    expect(container.querySelector('.mg-saju-bridge-line')?.textContent).toBe('목생화(木生火) 시너지! 서로 영감을 주는 사이');
    expect(stage.props?.frame).toEqual(alone());
    await act(async () => button(container, '다리 보기')!.click());
    expect(stage.props!.frame.halfWidth).toBeGreaterThan(alone().halfWidth);
    expect(container.querySelector('.mg-saju-stage')?.getAttribute('data-view')).toBe('bridge');
    expect(container.querySelector('.mg-saju-say')?.textContent).toBe('목생화(木生火) 시너지! 서로 영감을 주는 사이');
    await act(async () => button(container, '집 보기')!.click());
    expect(stage.props?.frame).toEqual(alone());
    await unmount();
  });

  it('이웃이 아닌 손님에게는 이웃 신청이 있고 다리 보기는 없다', async () => {
    auth = { status: 'signedIn', user: { id: 'u-bori', username: 'bori', displayName: '보리', role: 'user' } };
    villages['bori'] = { saju: home('bori'), village: [] };
    const { container, unmount } = await open('/@sol');
    expect(button(container, '이웃 신청')).toBeDefined();
    expect(button(container, '다리 보기')).toBeUndefined();
    expect(container.querySelector('.mg-saju-bridge-line')).toBeNull();
    await unmount();
  });

  it('로그인하지 않은 손님은 집과 방명록을 보고, 다리 칸에서 로그인으로 간다', async () => {
    auth = { status: 'anonymous', user: null };
    const { container, unmount } = await open('/@sol');
    expect(container.querySelector('.mg-saju-badge')).not.toBeNull();
    expect(container.querySelector('.guestbook')?.textContent).toBe('sol');
    expect(link(container, '내 집')).toBeUndefined();
    expect(container.querySelector('.mg-saju-bridge a')?.textContent?.trim()).toBe('로그인');
    expect(api.status).not.toHaveBeenCalled();
    await unmount();
  });

  it('아직 짓지 않은 남의 집은 빈 터로 보이고, 마을 지도가 대신 선다', async () => {
    auth = { status: 'signedIn', user: noeul };
    villages['sol'] = { saju: null, village: [around('noeul', true)] };
    const { container, unmount } = await open('/@sol');
    expect(container.querySelector('h1')?.textContent).toBe('모개의 섬');
    expect(container.querySelector('.mg-saju-form')).toBeNull();
    expect(container.querySelector('.mg-saju-badge')?.textContent).toBe('빈 터');
    expect(pins(container)).toEqual(['sol /@sol 빈 터', 'noeul /@noeul 노을내 집']);
    expect(menu(container)).toEqual(['홈* /@sol', '마을 /@sol/village']);
    await unmount();
  });

  it('이야기 패널은 접었다 펴고, 접어도 적던 것이 남으며, 다음에도 접힌 채로 연다', async () => {
    villages['sol'] = { saju: null, village: [] };
    const { container, unmount } = await open('/@sol');
    const panel = () => container.querySelector<HTMLElement>('.mg-saju-panel')!;
    expect(panel().hidden).toBe(false);
    expect(container.querySelector('.mg-saju-world')?.classList.contains('has-panel')).toBe(true);
    await type(field(container, 'year'), '1989');
    const close = () => container.querySelector<HTMLButtonElement>('.mg-saju-panel-close')!;
    const opener = () => container.querySelector<HTMLButtonElement>('.mg-saju-panel-open')!;
    expect([close().getAttribute('aria-expanded'), close().getAttribute('aria-controls')]).toEqual(['true', panel().id]);
    await act(async () => close().click());
    expect(panel().hidden).toBe(true);
    expect(container.querySelector('.mg-saju-world')?.classList.contains('has-panel')).toBe(false);
    // 누른 단추는 사라지고, 초점은 되돌리는 단추로 간다.
    expect(document.activeElement).toBe(opener());
    expect([opener().getAttribute('aria-expanded'), opener().getAttribute('aria-controls')]).toEqual(['false', panel().id]);
    await act(async () => opener().click());
    expect(panel().hidden).toBe(false);
    expect(document.activeElement).toBe(close());
    expect(field(container, 'year').value).toBe('1989');
    await act(async () => container.querySelector<HTMLButtonElement>('.mg-saju-panel-close')!.click());
    await unmount();
    const again = await open('/@sol');
    expect(again.container.querySelector<HTMLElement>('.mg-saju-panel')?.hidden).toBe(true);
    await again.unmount();
  });

  it('확대와 축소 단추는 캔버스에 그만큼 다가가고 물러나라고 한다', async () => {
    const { container, unmount } = await open('/@sol');
    const zoom = container.querySelector('[aria-label="확대와 축소"]')!;
    expect([...zoom.querySelectorAll('button')].map((item) => item.getAttribute('aria-label'))).toEqual(['축소', '확대']);
    await act(async () => zoom.querySelector<HTMLButtonElement>('[aria-label="확대"]')!.click());
    await act(async () => zoom.querySelector<HTMLButtonElement>('[aria-label="축소"]')!.click());
    expect(stage.zooms.map((factor) => factor > 1)).toEqual([true, false]);
    expect(stage.zooms[0]! * stage.zooms[1]!).toBeCloseTo(1, 9);
    await unmount();
  });

  it('둘레의 집을 누르면 그 섬으로 간다', async () => {
    const { container, unmount } = await open('/@sol/village');
    await act(async () => stage.props!.onVisit('noeul'));
    await settle();
    expect(where(container)).toBe('/@noeul');
    await unmount();
  });

  it('주인이 아니면 다시 입력하는 주소에서 집으로 돌아간다', async () => {
    auth = { status: 'signedIn', user: noeul };
    const { container, unmount } = await open('/@sol/edit');
    expect(where(container)).toBe('/@sol');
    expect(container.querySelector('.mg-saju-form')).toBeNull();
    await unmount();
  });

  it('머리띠와 패널, 독이 가린 만큼을 캔버스에 알리고, 다른 주소에서 돌아온 화면도 그렇게 한다', async () => {
    const boxes: Record<string, [number, number, number, number]> = {
      'mg-saju-world': [0, 0, 1000, 800],
      'mg-topbar': [20, 20, 980, 74],
      'mg-saju-dock': [118, 732, 568, 780],
      'mg-saju-panel': [588, 92, 980, 780],
    };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const [left, top, right, bottom] = Object.entries(boxes).find(([name]) => this.classList.contains(name))?.[1] ?? [0, 0, 0, 0];
      return { left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => ({}) };
    });
    const covered = { top: 74, right: 412, bottom: 68, left: 0 };
    auth = { status: 'signedIn', user: noeul };
    const direct = await open('/@sol');
    expect(stage.props?.inset).toEqual(covered);
    // 가린 만큼은 캔버스의 기다림 표시가 설 자리에도 쓰인다.
    expect(direct.container.querySelector<HTMLElement>('.mg-saju-stage')?.style.getPropertyValue('--mg-cover-right')).toBe('412px');
    await direct.unmount();
    const redirected = await open('/@sol/edit');
    expect(where(redirected.container)).toBe('/@sol');
    expect(stage.props?.inset).toEqual(covered);
    // 접으면 패널이 가리던 쪽이 열린다.
    await act(async () => redirected.container.querySelector<HTMLButtonElement>('.mg-saju-panel-close')!.click());
    expect(stage.props?.inset).toEqual({ ...covered, right: 0 });
    await redirected.unmount();
  });

  it('탭을 바꾸면 패널은 처음부터 보여 준다', async () => {
    const { container, unmount } = await open('/@sol');
    const side = container.querySelector<HTMLElement>('.mg-saju-side')!;
    for (const tab of ['사주보기', '자미두수', '홈', '마을']) {
      side.scrollTop = 120;
      await act(async () => link(container, tab)!.click());
      await settle();
      expect([tab, side.scrollTop]).toEqual([tab, 0]);
    }
    expect(where(container)).toBe('/@sol/village');
    // 글자판 없이도 읽어 내려갈 수 있게 초점을 받는다.
    expect(side.tabIndex).toBe(0);
    await unmount();
  });

  it('자미두수는 같은 틀 안에서 명반을 열고, 그 탭에서만 패널을 넓힌다', async () => {
    const { container, unmount } = await open('/@sol?view=ziwei');
    expect(menu(container)).toEqual(['홈 /@sol', '사주보기 /@sol?view=chart', '자미두수* /@sol?view=ziwei', '마을 /@sol/village']);
    expect(container.querySelector('.mg-saju-side [aria-label="자미두수 명반"]')).not.toBeNull();
    const world = container.querySelector('.mg-saju-world')!;
    const widen = () => container.querySelector<HTMLButtonElement>('.mg-saju-panel-roomy');
    expect([widen()?.getAttribute('aria-label'), widen()?.getAttribute('aria-pressed'), world.classList.contains('is-roomy')]).toEqual(['패널 넓히기', 'false', false]);
    await act(async () => widen()!.click());
    // 이름은 그대로이고 눌린 상태가 넓다는 것을 말한다.
    expect([widen()?.getAttribute('aria-label'), widen()?.getAttribute('aria-pressed'), world.classList.contains('is-roomy')]).toEqual(['패널 넓히기', 'true', true]);
    // 다른 탭에는 넓히는 단추가 없고, 넓혀 둔 패널도 그 탭에서만 넓다.
    await act(async () => link(container, '사주보기')!.click());
    await settle();
    expect(widen()).toBeNull();
    expect(world.classList.contains('is-roomy')).toBe(false);
    await unmount();
    const again = await open('/@sol?view=ziwei');
    expect(again.container.querySelector('.mg-saju-world')?.classList.contains('is-roomy')).toBe(true);
    await again.unmount();
  });

  it('시를 모르는 집에는 명반이 없어 패널을 넓히지 않고, 주인에게만 다시 입력하는 길이 있다', async () => {
    localStorage.setItem('minihome:saju:ziwei-wide', 'true');
    villages['sol'] = { saju: { name: '솔', birth: { ...personOf('sol').birth, time: null } }, village: [] };
    const own = await open('/@sol?view=ziwei');
    expect(own.container.querySelector('.mg-saju-side [aria-label="자미두수 명반"]')).not.toBeNull();
    expect(own.container.querySelector('.mg-saju-panel-roomy')).toBeNull();
    expect(own.container.querySelector('.mg-saju-world')?.classList.contains('is-roomy')).toBe(false);
    expect(link(own.container, '사주 다시 입력')?.getAttribute('href')).toBe('/@sol/edit');
    // 넓혀 둔 것은 명반이 있는 집을 위해 그대로 남는다.
    expect(localStorage.getItem('minihome:saju:ziwei-wide')).toBe('true');
    await own.unmount();
    auth = { status: 'signedIn', user: noeul };
    const visit = await open('/@sol?view=ziwei');
    expect(link(visit.container, '사주 다시 입력')).toBeUndefined();
    await visit.unmount();
  });

  it('이웃이 열 명이면 깃발 섬이 집의 오행으로 서고, 마을 틀만 그 섬을 담는다', async () => {
    api.ilchons.mockResolvedValue({ ilchons: ilchons(10) });
    const village = await open('/@sol/village');
    expect(stage.props?.flag).toEqual({ ...FLAG_SPOT, element: 'wood' });
    expect(stage.props?.frame).toEqual(frameOf([...stage.props!.homes, FLAG_SPOT]));
    expect(village.container.querySelector('.mg-saju-flag h2')?.textContent).toBe('깃발 섬 이웃 10명');
    await village.unmount();
    const own = await open('/@sol');
    expect(stage.props?.flag).toEqual({ ...FLAG_SPOT, element: 'wood' });
    expect(stage.props?.frame).toEqual(alone());
    await own.unmount();
    // 다리 보기는 두 집만 담는다.
    auth = { status: 'signedIn', user: noeul };
    api.status.mockResolvedValue(standing('ilchon'));
    const visit = await open('/@sol');
    await act(async () => button(visit.container, '다리 보기')!.click());
    const homes = stage.props!.homes;
    expect(stage.props?.frame).toEqual(frameOf([homes.find((item) => item.id === 'noeul')!, homes[0]!]));
    await visit.unmount();
  });

  it('이웃이 아홉 명이면 깃발은 없고, 카드가 몇 명인지 말한다', async () => {
    api.ilchons.mockResolvedValue({ ilchons: ilchons(9) });
    const { container, unmount } = await open('/@sol/village');
    expect(stage.props?.flag).toBeNull();
    expect(stage.props?.frame).toEqual(frameOf(stage.props!.homes));
    expect(container.querySelector('.mg-saju-flag h2')?.textContent).toBe('깃발 섬 이웃 9/10');
    expect(container.querySelector('.mg-neighbors .mg-list-count')?.textContent).toBe('이웃 9');
    await unmount();
  });

  it('이웃 목록을 아직 읽지 못했으면 몇 명인지 말하지 않고, 읽으면 깃발을 올린다', async () => {
    let answer: (value: { ilchons: Ilchon[] }) => void = () => undefined;
    api.ilchons.mockReturnValue(new Promise((done) => { answer = done; }));
    const { container, unmount } = await open('/@sol/village');
    expect(stage.props?.flag).toBeNull();
    expect(container.querySelector('.mg-saju-flag')).toBeNull();
    expect(container.querySelector('.mg-neighbors')?.textContent).toBe('');
    await act(async () => answer({ ilchons: ilchons(11) }));
    await settle();
    expect(stage.props?.flag).toEqual({ ...FLAG_SPOT, element: 'wood' });
    expect(container.querySelector('.mg-saju-flag h2')?.textContent).toBe('깃발 섬 이웃 11명');
    expect(container.querySelector('.mg-neighbors .mg-list-count')?.textContent).toBe('이웃 11');
    await unmount();
  });

  it('이웃을 읽다 실패하면 없다고 하지 않고 실패했다고만 한다', async () => {
    api.ilchons.mockResolvedValue({ ilchons: ilchons(11) });
    // 함께 읽는 받은 신청이 실패하면 목록도 읽지 못한 것으로 남는다.
    api.requests.mockRejectedValue(new Error('unavailable'));
    const { container, unmount } = await open('/@sol/village');
    expect(stage.props?.flag).toBeNull();
    expect(container.querySelector('.mg-saju-flag')).toBeNull();
    expect(container.querySelector('.mg-neighbors .mg-list-count')).toBeNull();
    expect(container.querySelector('.mg-neighbors .mg-empty')).toBeNull();
    expect(container.querySelector('.mg-neighbors [role=alert]')?.textContent).toBe('잠시 후 다시 시도해 주세요');
    await unmount();
  });

  it('건드리지 않은 패널은 창을 따르고, 휴대폰에서 접은 것이 넓은 창의 패널을 접지 않는다', async () => {
    const phone = { matches: true };
    vi.stubGlobal('matchMedia', () => phone);
    const hidden = (container: HTMLElement) => container.querySelector<HTMLElement>('.mg-saju-panel')!.hidden;
    // 휴대폰에서는 접힌 채로 열리고, 그 기본값은 남기지 않는다.
    const first = await open('/@sol');
    expect(hidden(first.container)).toBe(true);
    expect(Object.keys(localStorage).filter((key) => key.startsWith('minihome:saju:'))).toEqual([]);
    await act(async () => first.container.querySelector<HTMLButtonElement>('.mg-saju-panel-open')!.click());
    await act(async () => first.container.querySelector<HTMLButtonElement>('.mg-saju-panel-close')!.click());
    expect(hidden(first.container)).toBe(true);
    await first.unmount();
    phone.matches = false;
    const wide = await open('/@sol');
    expect(hidden(wide.container)).toBe(false);
    await wide.unmount();
    // 휴대폰에서 펴 둔 것은 휴대폰에서 남는다.
    phone.matches = true;
    const opened = await open('/@sol');
    await act(async () => opened.container.querySelector<HTMLButtonElement>('.mg-saju-panel-open')!.click());
    await opened.unmount();
    const again = await open('/@sol');
    expect(hidden(again.container)).toBe(false);
    await again.unmount();
  });

  it('창의 제목이 누구의 섬인지 말하고, 이야기 패널이 화면의 본문이다', async () => {
    document.title = '모개숲';
    const { container, unmount } = await open('/@sol');
    expect(document.title).toBe('솔의 섬 · 모개숲');
    expect(container.querySelector('main.mg-saju-panel')?.getAttribute('aria-label')).toBe('솔의 섬');
    await unmount();
    expect(document.title).toBe('모개숲');
  });

  it('답이 오지 않으면 까닭을 제목이 한 번만 말한다', async () => {
    api.mine.mockRejectedValue(new TypeError('Failed to fetch'));
    const silent = await open('/@sol');
    expect(silent.container.querySelector('h1')?.textContent).toBe('섬을 불러오지 못했어요');
    expect(silent.container.querySelector('.mg-muted')).toBeNull();
    await silent.unmount();
    // 서버가 까닭을 말하면 그 말을 덧붙인다.
    api.mine.mockRejectedValue(new ApiRequestError(500, 'internal', '요청이 실패했어요 (500)'));
    const failed = await open('/@sol');
    expect(failed.container.querySelector('.mg-muted')?.textContent).toBe('요청이 실패했어요 (500)');
    await failed.unmount();
  });

  it('없는 집과 닫힌 집은 까닭을 말하고, 로그인했으면 내 집으로, 아니면 로그인으로 보낸다', async () => {
    const links = (container: HTMLElement) => [...container.querySelectorAll('a')].map((anchor) => `${anchor.textContent?.trim()} ${anchor.getAttribute('href')}`);
    auth = { status: 'signedIn', user: noeul };
    api.get.mockRejectedValue(new ApiRequestError(404, 'home_not_found', '없는 섬입니다.'));
    const missing = await open('/@sol');
    expect(missing.container.querySelector('h1')?.textContent).toBe('없는 섬이에요');
    // 까닭은 제목이 말한다: 서버의 문장을 덧붙이지 않는다.
    expect(missing.container.querySelector('.mg-muted')).toBeNull();
    // 둘러보기는 없다.
    expect(links(missing.container)).toEqual(['내 집 /@noeul']);
    await missing.unmount();
    auth = { status: 'anonymous', user: null };
    api.get.mockRejectedValue(new ApiRequestError(403, 'home_private', '주인이 공개하지 않은 섬입니다.'));
    const closed = await open('/@sol');
    expect(closed.container.querySelector('h1')?.textContent).toBe('주인이 닫아 둔 섬이에요');
    expect(links(closed.container)).toEqual([`로그인 /?next=${encodeURIComponent('/@sol')}`]);
    await closed.unmount();
    // 읽지 못한 것이 제 집이면 갈 곳으로 그 집을 내놓지 않는다.
    auth = { status: 'signedIn', user: sol };
    api.mine.mockRejectedValue(new TypeError('Failed to fetch'));
    const own = await open('/@sol');
    expect(own.container.querySelector('h1')?.textContent).toBe('섬을 불러오지 못했어요');
    expect(links(own.container)).toEqual([]);
    await own.unmount();
  });
});
