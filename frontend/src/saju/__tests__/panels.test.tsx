import { act, type ReactNode } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mount, type } from '../../__tests__/mount';
import { compatOf } from '../compat';
import { profileOf } from '../profile';
import { MY_HOME, sampleOf, SEED_ENTRIES } from '../residents';
import { entriesOf, resetSajuStore, sajuStore } from '../store';
import { ChartPanel } from '../ui/ChartPanel';
import { Gauge } from '../ui/Gauge';
import { Guestbook } from '../ui/Guestbook';
import { HomePanel, type BridgeState } from '../ui/HomePanel';
import { VillagePanel } from '../ui/VillagePanel';

const noeul = sampleOf('noeul')!;
const profile = (id: string) => profileOf(sampleOf(id)!.birth);
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

describe('방명록', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSajuStore();
  });
  afterEach(() => {
    localStorage.clear();
    resetSajuStore();
  });

  const book = (canWrite: boolean) =>
    inRouter(<Guestbook home="noeul" entries={entriesOf(sajuStore.getState(), 'noeul')} canWrite={canWrite} elementOf={(author) => (author === 'sol' ? 'wood' : null)} />);

  it('집이 없으면 쓰는 칸 대신 집 짓기가 있다', async () => {
    const { container, unmount } = await book(false);
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('a.mg-btn')?.getAttribute('href')).toBe('/saju');
    expect(texts(container, 'h2')).toEqual(['방명록 3']);
    // 샘플 주민의 글은 새 글이 위에 오고, 지울 수 없다.
    expect(texts(container, '.mg-saju-entry-meta b')).toEqual(['솔', '가람', '보리']);
    expect(container.querySelector('.mg-saju-entry-meta button')).toBeNull();
    expect(container.querySelector('.mg-saju-entry-meta time')?.textContent).toBe('2026.11.11');
    expect(container.querySelector('.mg-saju-entry-mark')?.getAttribute('href')).toBe('/saju/home/sol');
    expect(container.querySelector<HTMLElement>('.mg-saju-entry-mark')?.dataset['element']).toBe('wood');
    await unmount();
  });

  it('한 줄 남기면 저장되고, 내 글은 지울 수 있다', async () => {
    sajuStore.moveIn('가온', { calendar: 'solar', year: 1990, month: 1, day: 1, leapMonth: false, time: '12:00', gender: 'male' });
    const first = await book(true);
    const input = first.container.querySelector<HTMLInputElement>('input')!;
    const send = first.container.querySelector<HTMLButtonElement>('button[type=submit]')!;
    expect(send.disabled).toBe(true);
    await type(input, '  불멍하러 왔어요  ');
    expect(send.disabled).toBe(false);
    await act(async () => first.container.querySelector('form')!.requestSubmit());
    expect(input.value).toBe('');
    expect(sajuStore.getState().entries.at(-1)).toMatchObject({ home: 'noeul', author: MY_HOME, name: '가온', body: '불멍하러 왔어요' });
    await first.unmount();

    const second = await book(true);
    expect(texts(second.container, '.mg-saju-entry-body')[0]).toBe('불멍하러 왔어요');
    const remove = second.container.querySelector<HTMLButtonElement>('.mg-saju-entry-meta button')!;
    expect(remove.getAttribute('aria-label')).toBe('가온의 글 삭제');
    await act(async () => remove.click());
    expect(sajuStore.getState().entries.some((entry) => entry.home === 'noeul')).toBe(false);
    await second.unmount();
  });
});

describe('집 이야기', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSajuStore();
  });
  afterEach(() => {
    localStorage.clear();
    resetSajuStore();
  });

  const panel = (bridge: BridgeState | null, mine = false, onShow: (shown: boolean) => void = () => {}) =>
    inRouter(
      <HomePanel
        resident={noeul}
        profile={profile('noeul')}
        mine={mine}
        bridge={bridge}
        onShowBridge={onShow}
        entries={SEED_ENTRIES.filter((entry) => entry.home === 'noeul')}
        canWrite={false}
        elementOf={() => null}
      />,
    );
  const compat = compatOf(profile('sol'), profile('noeul'));

  it('일간 한 줄, 집과 수호 캐릭터, 신살이 준 것을 보여 준다', async () => {
    const { container, unmount } = await panel(null);
    expect(container.querySelector('.mg-saju-badge')?.textContent).toBe('따뜻한 촛불 같은 정화(丁火) 일간');
    expect(texts(container, '.mg-saju-who .mg-chip')).toEqual(['붉은 벽돌집', '붉은 닭 · 정유(丁酉)', '천을귀인의 별', '도화의 꽃', '백호의 목도리']);
    // 남의 집은 고칠 수 없고, 다리 칸은 이웃의 집에만 있다.
    expect(container.querySelector('.mg-saju-who-edit')).toBeNull();
    expect(container.querySelector('.mg-saju-bridge')).toBeNull();
    await unmount();
    const own = await panel(null, true);
    expect(own.container.querySelector('.mg-saju-who-edit')?.getAttribute('href')).toBe('/saju/edit');
    await own.unmount();
  });

  it('집이 없으면 다리 대신 집 짓기를 권한다', async () => {
    const { container, unmount } = await panel({ kind: 'homeless' });
    expect(container.querySelector('.mg-saju-bridge a')?.getAttribute('href')).toBe('/saju');
    expect(container.querySelector('.mg-saju-bridge button')).toBeNull();
    await unmount();
  });

  it('다리를 놓으면 저장하고 두 집을 함께 보여 달라고 한다', async () => {
    sajuStore.moveIn('가온', sampleOf('sol')!.birth);
    const shown: boolean[] = [];
    const { container, unmount } = await panel({ kind: 'open', compat }, false, (value) => shown.push(value));
    expect(container.querySelector('.mg-saju-bridge-line')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('.mg-saju-bridge button')!.click());
    expect(sajuStore.getState().bridges).toEqual(['noeul']);
    expect(shown).toEqual([true]);
    await unmount();
  });

  it('놓인 다리는 궁합 한 줄과 찾은 관계를 보여 주고, 다리와 집을 오간다', async () => {
    const shown: boolean[] = [];
    const { container, rerender, unmount } = await panel({ kind: 'built', compat, shown: false }, false, (value) => shown.push(value));
    expect(container.querySelector('.mg-saju-bridge-line')?.textContent).toBe('목생화(木生火) 시너지! 서로 영감을 주는 사이');
    expect(texts(container, '.mg-saju-bridge .mg-chip')).toEqual(['집 목생화(木生火)']);
    const toggle = () => container.querySelector<HTMLButtonElement>('.mg-saju-bridge button')!;
    expect(toggle().textContent?.trim()).toBe('다리 보기');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    await act(async () => toggle().click());
    expect(shown).toEqual([true]);
    await rerender(
      <MemoryRouter>
        <HomePanel resident={noeul} profile={profile('noeul')} mine={false} bridge={{ kind: 'built', compat, shown: true }} onShowBridge={(value) => shown.push(value)} entries={[]} canWrite={false} elementOf={() => null} />
      </MemoryRouter>,
    );
    expect(toggle().textContent?.trim()).toBe('집 보기');
    await act(async () => toggle().click());
    expect(shown).toEqual([true, false]);
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
  const villagers = ['sol', 'noeul'].map((id) => ({ resident: sampleOf(id)!, profile: profile(id), bridged: id === 'noeul' }));

  it('주민마다 집으로 가는 길과 사주 한 줄이 있다', async () => {
    const { container, unmount } = await inRouter(<VillagePanel villagers={villagers} hasHome />);
    expect(texts(container, 'h2')).toEqual(['주민 2']);
    const cards = [...container.querySelectorAll<HTMLAnchorElement>('a.mg-saju-villager')];
    expect(cards.map((card) => card.getAttribute('href'))).toEqual(['/saju/home/sol', '/saju/home/noeul']);
    expect(cards.map((card) => card.dataset['element'])).toEqual(['wood', 'fire']);
    expect(texts(cards[1]!, 'b')).toEqual(['노을샘플다리 놓음']);
    expect(texts(cards[1]!, 'small')).toEqual(['따뜻한 촛불 같은 정화(丁火) 일간', '붉은 벽돌집 · 붉은 닭']);
    // 여덟 글자를 오행 순으로 늘어놓는다.
    expect([...cards[1]!.querySelectorAll<HTMLElement>('.mg-saju-mix i')].map((item) => item.dataset['element'])).toEqual(['wood', 'wood', 'fire', 'fire', 'fire', 'fire', 'earth', 'metal']);
    await unmount();
  });

  it('집이 없으면 빈 터가 먼저 있다', async () => {
    const { container, unmount } = await inRouter(<VillagePanel villagers={villagers} hasHome={false} />);
    const first = container.querySelector<HTMLAnchorElement>('a.mg-saju-villager')!;
    expect(first.getAttribute('href')).toBe('/saju');
    expect(first.textContent).toContain('빈 터');
    expect(first.textContent).toContain('내 집 짓기');
    await unmount();
  });
});
