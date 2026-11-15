import { act, useImperativeHandle, type ReactNode, type Ref } from 'react';

import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../api/client';
import type { HomeView, IlchonStatus, SajuVillage, User } from '../../api/types';
import { mount, type } from '../../__tests__/mount';
import type { Frame } from '../scene/frames';
import type { StageBridge, StageHandle, StageHome } from '../scene/Stage';
import { PLOT_REACH } from '../village';
import { personOf } from './people';

type StageProps = { ref?: Ref<StageHandle>; homes: StageHome[]; bridges: StageBridge[]; frame: Frame; focus: string | null; onVisit: (id: string) => void; pins?: ReactNode };
const { stage, api } = vi.hoisted(() => ({
  stage: { props: null as StageProps | null, zooms: [] as number[] },
  api: { mine: vi.fn(), get: vi.fn(), visit: vi.fn(), village: vi.fn(), save: vi.fn(), remove: vi.fn(), ilchons: vi.fn(), requests: vi.fn(), status: vi.fn() },
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
  Rail: () => <nav className="rail" />,
  TopActions: ({ children }: { children?: ReactNode }) => <div className="top-actions">{children}</div>,
  initialOf: (name: string) => name.slice(0, 1),
  toneOf: () => '0',
  REQUESTS_CHANGED: 'mogaesup:requests',
}));
vi.mock('../../minihome/Guestbook', () => ({ Guestbook: ({ username }: { username: string }) => <p className="guestbook">{username}</p> }));
vi.mock('../../api/endpoints', () => ({
  homeApi: { mine: api.mine, get: api.get, visit: api.visit },
  sajuApi: { village: api.village, save: api.save, remove: api.remove },
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

function Page() {
  const { slug = '', '*': rest = '' } = useParams();
  return <SajuPage key={slug} username={slug.slice(1)} rest={rest} />;
}
function Where() {
  const { pathname, search } = useLocation();
  return <output>{pathname + search}</output>;
}
const settle = () => act(async () => { for (let round = 0; round < 5; round++) await new Promise((done) => setTimeout(done, 0)); });

describe('미니홈피 화면', () => {
  /** What the server holds: each member's village by username. */
  let villages: Record<string, SajuVillage>;

  beforeEach(() => {
    localStorage.clear();
    stage.props = null;
    stage.zooms = [];
    auth = { status: 'signedIn', user: sol };
    villages = { sol: { saju: home('sol'), village: [around('noeul', true), around('bori', false)] }, noeul: { saju: home('noeul'), village: [around('sol', true)] } };
    api.mine.mockImplementation(async () => view(true));
    api.get.mockImplementation(async () => view(false));
    api.visit.mockResolvedValue(null);
    api.village.mockImplementation(async (username: string) => villages[username] ?? { saju: null, village: [] });
    api.ilchons.mockResolvedValue({ ilchons: [] });
    api.requests.mockResolvedValue({ received: [], sent: [] });
    api.status.mockResolvedValue(standing('none'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    localStorage.clear();
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
    // 캔버스가 창을 채우고, 앱의 머리띠와 레일이 그 위에 뜬다.
    expect(container.querySelector('.mg-saju-world > .mg-saju-stage .stage')).not.toBeNull();
    expect(container.querySelector('.mg-saju-world > .mg-topbar .brand')).not.toBeNull();
    expect(container.querySelector('.mg-saju-world > .rail')).not.toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe('모개의 미니홈피');
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
    expect(container.querySelector('h1')?.textContent).toBe('솔의 미니홈피');
    expect(stage.props?.focus).toBe('sol');
    expect(stage.props?.frame).toMatchObject({ target: [0, 1.5, 0], halfWidth: 8 });
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
    expect(stage.props!.frame.halfWidth).toBeGreaterThan(8);
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
    expect(container.querySelector('h1')?.textContent).toBe('솔이의 미니홈피');
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
    expect(stage.props?.frame.halfWidth).toBe(8);
    await act(async () => button(container, '다리 보기')!.click());
    expect(stage.props!.frame.halfWidth).toBeGreaterThan(8);
    expect(container.querySelector('.mg-saju-stage')?.getAttribute('data-view')).toBe('bridge');
    expect(container.querySelector('.mg-saju-say')?.textContent).toBe('목생화(木生火) 시너지! 서로 영감을 주는 사이');
    await act(async () => button(container, '집 보기')!.click());
    expect(stage.props?.frame.halfWidth).toBe(8);
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
    expect(container.querySelector('h1')?.textContent).toBe('모개의 미니홈피');
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
    await act(async () => container.querySelector<HTMLButtonElement>('.mg-saju-panel-close')!.click());
    expect(panel().hidden).toBe(true);
    expect(container.querySelector('.mg-saju-world')?.classList.contains('has-panel')).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('.mg-saju-panel-open')!.click());
    expect(panel().hidden).toBe(false);
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

  it('둘레의 집을 누르면 그 미니홈피로 간다', async () => {
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

  it('없는 집과 닫힌 집은 까닭을 말하고 둘러보기로 보낸다', async () => {
    api.mine.mockRejectedValue(new ApiRequestError(404, 'home_not_found', '없는 미니홈피입니다.'));
    const missing = await open('/@sol');
    expect(missing.container.querySelector('h1')?.textContent).toBe('없는 미니홈피예요');
    // 까닭은 제목이 말한다: 서버의 문장을 덧붙이지 않는다.
    expect(missing.container.querySelector('.mg-muted')).toBeNull();
    expect(link(missing.container, '둘러보기')?.getAttribute('href')).toBe('/explore');
    await missing.unmount();
    auth = { status: 'anonymous', user: null };
    api.get.mockRejectedValue(new ApiRequestError(403, 'home_private', '주인이 공개하지 않은 미니홈피입니다.'));
    const closed = await open('/@sol');
    expect(closed.container.querySelector('h1')?.textContent).toBe('주인이 닫아 둔 미니홈피예요');
    expect(link(closed.container, '로그인')).toBeDefined();
    await closed.unmount();
  });
});
