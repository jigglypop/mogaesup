import { act, type ReactNode } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeView, HomeVisibility, IlchonRequest, IlchonStatus, User } from '../../api/types';
import { mount } from '../../__tests__/mount';
import type { Neighbors } from '../../minihome/Ilchons';
import { compatOf } from '../compat';
import { profileOf } from '../profile';
import { ChartPanel } from '../ui/ChartPanel';
import { Gauge } from '../ui/Gauge';
import { HomePanel, type Bridge } from '../ui/HomePanel';
import { FlagCard, VillagePanel } from '../ui/VillagePanel';
import { personOf } from './people';

const { accept, dismiss, unlink } = vi.hoisted(() => ({ accept: vi.fn(), dismiss: vi.fn(), unlink: vi.fn() }));
vi.mock('../../api/endpoints', () => ({ socialApi: { accept, dismiss, unlink } }));
vi.mock('../../shell/Shell', () => ({ initialOf: (name: string) => name.slice(0, 1), toneOf: () => '0', REQUESTS_CHANGED: 'mogaesup:requests' }));
vi.mock('../../minihome/Guestbook', () => ({
  Guestbook: ({ username, viewer }: { username: string; viewer: User | null }) => <p className="guestbook">{`${username}:${viewer?.username ?? '-'}`}</p>,
}));

const noeul = personOf('noeul');
const profile = (id: string) => profileOf(personOf(id).birth);
const texts = (container: HTMLElement, selector: string) => [...container.querySelectorAll(selector)].map((element) => element.textContent?.replace(/\s+/g, ' ').trim());
const inRouter = (element: ReactNode) => mount(<MemoryRouter>{element}</MemoryRouter>);

describe('오행 밸런스', () => {
  it('글자 하나에 칸 하나, 그 오행의 글자만큼 켠다', async () => {
    const { container, unmount } = await mount(<Gauge balance={profile('noeul').balance} />);
    const rows = [...container.querySelectorAll('li')];
    expect(rows.map((row) => row.dataset['element'])).toEqual(['wood', 'fire', 'earth', 'metal', 'water']);
    expect(rows.map((row) => row.querySelectorAll('i').length)).toEqual([8, 8, 8, 8, 8]);
    expect(rows.map((row) => row.querySelectorAll('i.is-lit').length)).toEqual([2, 4, 1, 1, 0]);
    expect(texts(container, 'li b')).toEqual(['25%', '50%', '13%', '12%', '0%']);
    expect(rows[1]?.getAttribute('aria-label')).toBe('화(火) 50%, 8글자 중 4글자');
    await unmount();
  });

  it('시를 모르는 사주는 여섯 칸이다', async () => {
    const { container, unmount } = await mount(<Gauge balance={profileOf({ ...noeul.birth, time: null }).balance} />);
    expect(container.querySelectorAll('li:first-child i').length).toBe(6);
    await unmount();
  });
});

describe('집 이야기', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  const sol: User = { id: 'u1', username: 'sol', displayName: '솔이', role: 'user' };
  const owner: User = { id: 'u2', username: 'noeul', displayName: '노을이', role: 'user' };
  const view = (isOwner: boolean): HomeView => ({
    isOwner,
    visits: { today: 0, total: 0 },
    profile: { ownerId: 'u2', username: 'noeul', ownerName: '노을이', title: '', statusMessage: '', mood: 0, minime: 'man', emoji: '😊', visibility: 'public', updatedAt: '2026-11-01T00:00:00Z' },
  });
  const neighbors = (changes: Partial<Neighbors> = {}): Neighbors => ({ list: [], received: [], status: null, error: '', act: (action) => void action(), ...changes });
  const standing = (relation: IlchonStatus['relation']): IlchonStatus => ({
    relation,
    ilchon: relation === 'ilchon' ? { user: { id: 'u2', username: 'noeul', displayName: '노을이', emoji: '😊' }, name: '옆집', theirName: '앞집', since: '2026-11-01T00:00:00Z' } : null,
    request: null,
  });
  const noBridge: Bridge = { compat: null, canShow: false, shown: false, onShow: () => {} };
  const compat = compatOf(profile('sol'), profile('noeul'));
  const visibility = vi.fn(async (_visibility: HomeVisibility) => undefined);
  const panel = (props: { isOwner?: boolean; viewer?: User | null; built?: boolean; neighbors?: Neighbors; bridge?: Bridge; open?: HomeVisibility } = {}) => (
    <HomePanel
      view={{ ...view(props.isOwner ?? false), profile: { ...view(false).profile, visibility: props.open ?? 'public' } }}
      viewer={props.viewer ?? null}
      profile={props.built === false ? null : profile('noeul')}
      neighbors={props.neighbors ?? neighbors()}
      bridge={props.bridge ?? noBridge}
      onVisibility={visibility}
    />
  );

  it('일간 한 줄, 집과 수호 캐릭터, 신살이 준 것을 보여 주고 그 집의 방명록을 연다', async () => {
    const { container, unmount } = await inRouter(panel());
    expect(container.querySelector('.mg-saju-badge')?.textContent).toBe('따뜻한 촛불 같은 정화(丁火) 일간');
    expect(texts(container, '.mg-saju-who .mg-chip')).toEqual(['붉은 벽돌집', '왕관 강아지 · 정유(丁酉)', '천을귀인의 별', '도화의 꽃', '백호의 목도리']);
    expect(container.querySelector('.guestbook')?.textContent).toBe('noeul:-');
    // 남의 집은 다시 입력할 수 없고, 로그인하지 않으면 다리 칸에는 로그인이 있다.
    expect(container.querySelector('.mg-saju-who-edit')).toBeNull();
    expect(texts(container, '.mg-saju-bridge a')).toEqual(['로그인']);
    await unmount();
  });

  it('내 집에는 사주 다시 입력이 있고, 받은 이웃 신청이 있을 때만 그 칸이 선다', async () => {
    const own = await inRouter(panel({ isOwner: true, viewer: owner }));
    expect(own.container.querySelector('.mg-saju-who-edit')?.getAttribute('href')).toBe('/@noeul/edit');
    expect(own.container.querySelector('.mg-saju-who-edit')?.textContent?.trim()).toBe('사주 다시 입력');
    expect(own.container.querySelector('.mg-saju-bridge')).toBeNull();
    await own.unmount();

    const request: IlchonRequest = {
      id: 'r1',
      from: { id: 'u1', username: 'sol', displayName: '솔이', emoji: '😊' },
      to: { id: 'u2', username: 'noeul', displayName: '노을이', emoji: '😊' },
      name: '옆집',
      theirName: '앞집',
      message: '이웃해요',
      createdAt: '2026-11-01T00:00:00Z',
    };
    accept.mockResolvedValue(standing('ilchon'));
    const asked = await inRouter(panel({ isOwner: true, viewer: owner, neighbors: neighbors({ received: [request] }) }));
    expect(asked.container.querySelector('.mg-saju-bridge')?.getAttribute('aria-label')).toBe('이웃 신청');
    expect(texts(asked.container, '.mg-people li b')).toEqual(['솔이']);
    await act(async () => [...asked.container.querySelectorAll('button')].find((button) => button.textContent?.trim() === '수락')!.click());
    expect(accept).toHaveBeenCalledExactlyOnceWith('r1', {});
    await asked.unmount();
  });

  it('주인은 누가 놀러 올 수 있는지 고르고, 손님에게는 그 칸이 없다', async () => {
    const own = await inRouter(panel({ isOwner: true, viewer: owner, open: 'ilchon' }));
    const doors = () => [...own.container.querySelectorAll<HTMLButtonElement>('[aria-label="공개 범위"] button')];
    expect(doors().map((door) => `${door.textContent}${door.getAttribute('aria-checked') === 'true' ? '*' : ''}`)).toEqual(['모두', '이웃만*', '나만']);
    // 이미 고른 것은 다시 보내지 않는다.
    await act(async () => doors()[1]!.click());
    expect(visibility).not.toHaveBeenCalled();
    await act(async () => doors()[2]!.click());
    expect(visibility).toHaveBeenCalledExactlyOnceWith('private');
    // 서버가 거절하면 까닭을 말한다.
    visibility.mockRejectedValueOnce(new Error('끊김'));
    await act(async () => doors()[0]!.click());
    expect(own.container.querySelector('[aria-label="공개 범위"] [role=alert]')?.textContent).toBe('잠시 후 다시 시도해 주세요');
    await own.unmount();
    const guest = await inRouter(panel({ viewer: sol }));
    expect(guest.container.querySelector('[aria-label="공개 범위"]')).toBeNull();
    await guest.unmount();
  });

  it('이웃이 아닌 손님에게는 이웃 신청이 있고, 궁합은 아직 말하지 않는다', async () => {
    const { container, unmount } = await inRouter(panel({ viewer: sol, neighbors: neighbors({ status: standing('none') }), bridge: { ...noBridge, compat } }));
    expect(texts(container, '.mg-saju-bridge button')).toEqual(['이웃 신청']);
    expect(container.querySelector('.mg-saju-bridge-line')).toBeNull();
    expect(container.querySelector('.mg-saju-bridge')?.classList.contains('is-built')).toBe(false);
    await unmount();
  });

  it('이웃 사이에는 궁합 한 줄과 찾은 관계가 있고, 다리와 집을 오간다', async () => {
    const shown: boolean[] = [];
    const bridge = (now: boolean): Bridge => ({ compat, canShow: true, shown: now, onShow: (value) => shown.push(value) });
    const joined = neighbors({ status: standing('ilchon') });
    const { container, rerender, unmount } = await inRouter(panel({ viewer: sol, neighbors: joined, bridge: bridge(false) }));
    expect(container.querySelector('.mg-saju-bridge')?.classList.contains('is-built')).toBe(true);
    expect(container.querySelector('.mg-saju-bridge-line')?.textContent).toBe('목생화(木生火) 시너지! 서로 영감을 주는 사이');
    expect(texts(container, '.mg-saju-bridge .mg-chip')).toEqual(['집 목생화(木生火)']);
    expect(texts(container, '.mg-state span')).toEqual(['이웃 · 나의 옆집']);
    const toggle = () => container.querySelector<HTMLButtonElement>('.mg-saju-bridge button[aria-pressed]')!;
    expect(toggle().textContent?.trim()).toBe('다리 보기');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    await act(async () => toggle().click());
    expect(shown).toEqual([true]);
    await rerender(<MemoryRouter>{panel({ viewer: sol, neighbors: joined, bridge: bridge(true) })}</MemoryRouter>);
    expect(toggle().textContent?.trim()).toBe('집 보기');
    await act(async () => toggle().click());
    expect(shown).toEqual([true, false]);
    await unmount();
  });

  it('내 집이 이 마을에 서 있지 않으면 다리 보기는 없고, 집이 없는 이웃 사이에는 궁합도 없다', async () => {
    const joined = neighbors({ status: standing('ilchon') });
    const away = await inRouter(panel({ viewer: sol, neighbors: joined, bridge: { ...noBridge, compat } }));
    expect(away.container.querySelector('.mg-saju-bridge-line')).not.toBeNull();
    expect(away.container.querySelector('.mg-saju-bridge button[aria-pressed]')).toBeNull();
    await away.unmount();
    const homeless = await inRouter(panel({ viewer: sol, neighbors: joined }));
    expect(homeless.container.querySelector('.mg-saju-bridge-line')).toBeNull();
    expect(texts(homeless.container, '.mg-state span')).toEqual(['이웃 · 나의 옆집']);
    await homeless.unmount();
  });

  it('아직 짓지 않은 집은 빈 터이고, 방명록과 다리 칸은 그대로 있다', async () => {
    const { container, unmount } = await inRouter(panel({ viewer: sol, built: false, neighbors: neighbors({ status: standing('none') }) }));
    expect(container.querySelector('.mg-saju-badge')?.textContent).toBe('빈 터');
    expect(container.querySelector('[aria-label="오행 밸런스"]')).toBeNull();
    expect(texts(container, '.mg-saju-bridge button')).toEqual(['이웃 신청']);
    expect(container.querySelector('.guestbook')?.textContent).toBe('noeul:sol');
    await unmount();
  });
});

describe('사주보기', () => {
  it('원국을 시·일·월·년 순으로, 십성과 지장간, 12운성, 납음과 함께 보여 준다', async () => {
    const { container, unmount } = await mount(<ChartPanel profile={profile('noeul')} />);
    expect(texts(container, '.mg-saju-pillars thead th')).toEqual(['시주', '일주', '월주', '년주']);
    const rows = [...container.querySelectorAll('.mg-saju-pillars tbody tr')].map((row) => [...row.children].map((cell) => cell.textContent?.trim()));
    expect(rows).toEqual([
      ['십성', '정인', '일원', '겁재', '비견'],
      ['천간', '甲갑', '丁정', '丙병', '丁정'],
      ['지지', '辰진', '酉유', '午오', '卯묘'],
      ['십성', '상관', '편재', '비견', '편인'],
      ['지장간', '무을계', '신', '정기', '을'],
      ['12운성', '쇠', '장생', '건록', '병'],
      ['납음', '복등화', '산하화', '천하수', '노중화'],
    ]);
    expect([...container.querySelectorAll<HTMLElement>('.mg-saju-glyph')].map((glyph) => glyph.dataset['element'])).toEqual(['wood', 'fire', 'fire', 'fire', 'earth', 'metal', 'fire', 'wood']);
    await unmount();
  });

  it('해당하는 신살과 12신살, 대운을 보여 주고 지금의 대운을 표시한다', async () => {
    const { container, unmount } = await mount(<ChartPanel profile={profile('noeul')} />);
    const sinsal = texts(container, '.mg-saju-sinsal li');
    // 신살 이름 뒤에 해당하는 기둥이 붙는다.
    expect(sinsal).toContain('천을귀인일');
    expect(sinsal).toContain('백호대살시');
    // 년지 卯에서 본 시·일·월·년지.
    expect(texts(container, '.mg-saju-twelve tbody tr:first-child td')).toEqual(['반안살', '재살', '육해살', '장성살']);
    const daYun = [...container.querySelectorAll('.mg-saju-dayun li')];
    expect(daYun.length).toBeGreaterThan(8);
    expect(daYun[0]?.querySelector('b')?.textContent).toBe('을사');
    expect(daYun.filter((item) => item.getAttribute('aria-current') === 'true')).toHaveLength(1);
    expect(container.querySelector('[aria-label=대운] h2 small')?.textContent).toMatch(/· 역행$/);
    await unmount();
  });

  it('시를 모르면 시주 칸이 비어 있다', async () => {
    const { container, unmount } = await mount(<ChartPanel profile={profileOf({ ...noeul.birth, time: null })} />);
    const cells = [...container.querySelectorAll('.mg-saju-pillars tbody tr')].map((row) => row.children[1]?.textContent);
    expect(cells).toEqual(['-', '-', '-', '-', '-', '-', '-']);
    expect(texts(container, '.mg-saju-twelve tbody tr:first-child td')[0]).toBe('-');
    await unmount();
  });
});

describe('마을 주민', () => {
  const villagers = ['sol', 'noeul', 'bori'].map((id) => ({ resident: personOf(id), profile: profile(id), bridged: id === 'noeul' }));
  const owner = { username: 'sol', name: '솔' };

  it('집마다 그 미니홈피로 가는 길과 사주 한 줄이 있고, 내 집과 이웃의 집을 표시한다', async () => {
    const { container, unmount } = await inRouter(<VillagePanel owner={owner} villagers={villagers} viewer="bori" />);
    expect(texts(container, 'h2')).toEqual(['주민 3']);
    const cards = [...container.querySelectorAll<HTMLAnchorElement>('a.mg-saju-villager')];
    expect(cards.map((card) => card.getAttribute('href'))).toEqual(['/@sol', '/@noeul', '/@bori']);
    expect(cards.map((card) => card.dataset['element'])).toEqual(['wood', 'fire', 'earth']);
    expect(texts(container, 'a.mg-saju-villager b')).toEqual(['솔', '노을이웃', '보리내 집']);
    expect(texts(cards[1]!, 'small')).toEqual(['따뜻한 촛불 같은 정화(丁火) 일간', '붉은 벽돌집 · 왕관 강아지']);
    // 여덟 글자를 오행 순으로 늘어놓는다.
    expect([...cards[1]!.querySelectorAll<HTMLElement>('.mg-saju-mix i')].map((item) => item.dataset['element'])).toEqual(['wood', 'wood', 'fire', 'fire', 'fire', 'fire', 'earth', 'metal']);
    await unmount();
  });

  it('주인이 아직 짓지 않았으면 빈 터가 먼저 있다', async () => {
    const around = villagers.slice(1);
    const mine = await inRouter(<VillagePanel owner={owner} villagers={around} viewer="sol" />);
    const lot = mine.container.querySelector<HTMLAnchorElement>('a.mg-saju-villager')!;
    expect(lot.getAttribute('href')).toBe('/@sol');
    expect(texts(lot, 'b, small')).toEqual(['빈 터', '내 집 짓기']);
    expect(texts(mine.container, 'h2')).toEqual(['주민 2']);
    await mine.unmount();
    // 남의 빈 터에는 주인의 이름이 있다.
    const theirs = await inRouter(<VillagePanel owner={owner} villagers={around} viewer={null} />);
    expect(texts(theirs.container.querySelector('a.mg-saju-villager')!, 'b, small')).toEqual(['빈 터', '솔']);
    await theirs.unmount();
  });
});

describe('깃발 섬 카드', () => {
  const lit = (container: HTMLElement) => container.querySelectorAll('.mg-saju-gauge-bar i.is-lit').length;

  it('이웃이 열 명이 되기 전에는 몇 명인지를 열 칸에 채운다', async () => {
    const { container, unmount } = await inRouter(<FlagCard neighbours={3} />);
    expect(texts(container, 'h2')).toEqual(['깃발 섬 이웃 3/10']);
    expect(container.querySelectorAll('.mg-saju-gauge-bar i')).toHaveLength(10);
    expect(lit(container)).toBe(3);
    expect(container.querySelector<HTMLElement>('.mg-saju-flag')!.dataset['raised']).toBeUndefined();
    await unmount();
  });

  it('열 명이 넘으면 깃발이 올랐다고 표시하고 이웃 수를 적는다', async () => {
    const { container, unmount } = await inRouter(<FlagCard neighbours={12} />);
    expect(texts(container, 'h2')).toEqual(['깃발 섬 이웃 12명']);
    expect(lit(container)).toBe(10);
    expect(container.querySelector<HTMLElement>('.mg-saju-flag')!.dataset['raised']).toBe('true');
    await unmount();
  });
});

