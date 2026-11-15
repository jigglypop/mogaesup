import { act } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import type { Birth } from '../engine';
import { ZiweiPanel } from '../ui/ZiweiPanel';
import { personOf } from './people';

const garam = personOf('garam').birth;
const panel = (birth: Birth, editTo: string | null = null) => (
  <MemoryRouter>
    <ZiweiPanel birth={birth} editTo={editTo} />
  </MemoryRouter>
);
const texts = (container: Element, selector: string) => [...container.querySelectorAll(selector)].map((element) => element.textContent?.replace(/\s+/g, ' ').trim());
const cells = (container: Element) => [...container.querySelectorAll<HTMLButtonElement>('button.mg-ziwei-palace')];
const named = (button: Element) => button.querySelector('.mg-ziwei-name')?.textContent;
const cell = (container: Element, name: string) => {
  const found = cells(container).find((button) => named(button) === name);
  if (!found) throw new Error(`no such palace: ${name}`);
  return found;
};
const pressed = (container: Element) => cells(container).filter((button) => button.getAttribute('aria-pressed') === 'true');
/** Each marked palace with how it stands to the picked one. */
const marked = (container: Element) => cells(container).flatMap((button) => (button.dataset['relation'] ? [`${named(button)} ${button.dataset['relation']}`] : []));
const rows = (container: Element) => [...container.querySelectorAll('.mg-ziwei-detail .mg-ziwei-rows > div')].map((row) => [row.querySelector('dt')?.textContent, texts(row, 'dd > *').join(' | ')]);

describe('자미두수 명반 패널', () => {
  // 지금의 대한은 차트를 처음 계산한 날로 정해진다: 그날을 정해 두고 본다. 2026년 11월의 가람은 서른다섯이다.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T12:00:00+09:00'));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('열두 궁이 버튼이고, 명궁부터 고리를 따라 놓인다', async () => {
    const { container, unmount } = await mount(panel(garam));
    expect(texts(container, '.mg-ziwei-board h2')).toEqual(['자미두수 명반']);
    expect(cells(container)).toHaveLength(12);
    expect(cells(container).map((button) => button.getAttribute('aria-label'))).toEqual([
      '명궁 기유, 천부',
      '부모 경술, 태음',
      '복덕 신해, 염정 탐랑',
      '전택 임자, 현재 대한, 거문',
      '관록 계축, 신궁, 천상',
      '노복 임인, 래인궁, 천동 천량',
      '천이 계묘, 무곡 칠살',
      '질액 갑진, 태양',
      '재백 을사',
      '자녀 병오, 천기',
      '부처 정미, 자미 파군',
      '형제 무신',
    ]);
    expect(cells(container).every((button) => button.type === 'button')).toBe(true);
    // 지지대로 4×4 고리에 놓인다: 유(酉)는 오른쪽 둘째 줄, 인(寅)은 왼쪽 아래, 사(巳)는 왼쪽 위.
    expect(['명궁', '노복', '재백', '전택'].map((name) => cell(container, name).style.gridArea)).toEqual(['2 / 4', '4 / 1', '1 / 1', '4 / 3']);
    expect(new Set(cells(container).map((button) => button.style.gridArea)).size).toBe(12);
    // 처음에는 명궁을 고른다.
    expect(pressed(container)).toEqual([cell(container, '명궁')]);
    expect(cells(container).filter((button) => button.dataset['soul'] === 'true')).toEqual([cell(container, '명궁')]);
    await unmount();
  });

  it('칸에는 주성의 밝기와 사화, 나머지 별, 대한이 있다', async () => {
    const { container, unmount } = await mount(panel(garam));
    const spouse = cell(container, '부처');
    expect(texts(spouse, '.mg-ziwei-ganji')).toEqual(['정미丁未']);
    expect(spouse.querySelector('.mg-ziwei-ganji [lang]')?.getAttribute('lang')).toBe('zh-Hant');
    expect(texts(spouse, '.mg-ziwei-major .mg-ziwei-star')).toEqual(['자미묘권', '파군왕']);
    expect(spouse.querySelector<HTMLElement>('.mg-ziwei-major .mg-ziwei-sahwa')?.dataset['sahwa']).toBe('권');
    // 좁은 칸은 잡성을 세고, 넓은 칸은 이름을 적는다: 둘 다 칸에 있고 폭이 고른다.
    expect(texts(spouse, '.mg-ziwei-more')).toEqual(['+2']);
    expect(texts(spouse, '.mg-ziwei-misc .mg-ziwei-star')).toEqual(['홍란', '과숙']);
    expect(texts(spouse, '.mg-ziwei-cycles > span')).toEqual(['양 병부', '천살 병부']);
    expect(texts(spouse, '.mg-ziwei-foot')).toEqual(['105–114']);
    const career = cell(container, '관록');
    const minor = [...career.querySelectorAll<HTMLElement>('.mg-ziwei-minor .mg-ziwei-star')];
    expect(minor.map((star) => `${star.dataset['kind']} ${star.textContent}`)).toEqual(['lucky 좌보과', 'lucky 우필', 'tough 지겁']);
    // 신궁과 래인궁은 넓은 칸에서는 이름 옆에, 좁은 칸에서는 발치에 적는다.
    expect(texts(career, '.mg-ziwei-head .mg-ziwei-flags i')).toEqual(['신궁']);
    expect(texts(career, '.mg-ziwei-foot .mg-ziwei-flags i')).toEqual(['신궁']);
    expect(texts(cell(container, '노복'), '.mg-ziwei-foot .mg-ziwei-flags i')).toEqual(['래인궁']);
    expect(cell(container, '명궁').querySelector('.mg-ziwei-flags')).toBeNull();
    expect(texts(cell(container, '재백'), '.mg-ziwei-major .mg-ziwei-star')).toEqual([]);
    // 지금의 대한인 궁만 그 나이에 표시가 있다.
    expect([...container.querySelectorAll<HTMLElement>('.mg-ziwei-decade[data-current]')].map((decade) => decade.textContent)).toEqual(['35–44']);
    expect(cell(container, '전택').querySelector('.mg-ziwei-decade[data-current]')).not.toBeNull();
    await unmount();
  });

  it('가운데에 명반의 요약이 있다', async () => {
    const { container, unmount } = await mount(panel(garam));
    const bureau = container.querySelector<HTMLElement>('.mg-ziwei-bureau')!;
    expect([bureau.textContent, bureau.dataset['element']]).toEqual(['토오국', 'earth']);
    expect([...container.querySelectorAll('.mg-ziwei-summary dl > div')].map((row) => texts(row, 'dt, dd'))).toEqual([
      ['명궁', '기유'],
      ['신궁', '계축'],
      ['명주', '문곡'],
      ['신주', '천량'],
      ['음력', '1992년 10월 18일'],
      ['시진', '인시 03:30~05:29'],
    ]);
    await unmount();
  });

  it('궁을 고르면 그 삼방사정을 표시하고 선을 긋는다', async () => {
    const { container, unmount } = await mount(panel(garam));
    const lines = () => ({
      trine: container.querySelector('.mg-ziwei-lines polygon')?.getAttribute('points'),
      across: ['x1', 'y1', 'x2', 'y2'].map((name) => container.querySelector('.mg-ziwei-lines line')?.getAttribute(name)).join(' '),
      ends: [...container.querySelectorAll<HTMLElement>('.mg-ziwei-lines i')].map((dot) => `${dot.style.left} ${dot.style.top}`),
    });
    // 명궁(酉)의 삼합은 축(丑)과 사(巳), 대궁은 묘(卯)다.
    expect(marked(container)).toEqual(['명궁 self', '관록 trine', '천이 opposite', '재백 trine']);
    expect(lines()).toEqual({ trine: '100,25 25,100 0,0', across: '100 25 0 75', ends: ['100% 25%', '25% 100%', '0% 0%', '0% 75%'] });
    expect(container.querySelector('.mg-ziwei-lines')?.getAttribute('aria-hidden')).toBe('true');

    await act(async () => cell(container, '노복').click());
    expect(pressed(container)).toEqual([cell(container, '노복')]);
    // 인(寅)의 삼합은 오(午)와 술(戌), 대궁은 신(申)이다.
    expect(marked(container)).toEqual(['부모 trine', '노복 self', '자녀 trine', '형제 opposite']);
    expect(lines()).toEqual({ trine: '0,100 25,0 100,75', across: '0 100 100 0', ends: ['0% 100%', '25% 0%', '100% 75%', '100% 0%'] });
    // 명궁의 표시는 다른 궁을 골라도 남는다.
    expect(cell(container, '명궁').dataset['soul']).toBe('true');
    expect(cell(container, '명궁').dataset['relation']).toBeUndefined();
    await unmount();
  });

  it('고른 궁의 별과 삼방사정, 12신, 대한과 소한, 비성사화를 아래에 보여 준다', async () => {
    const { container, unmount } = await mount(panel(garam));
    const detail = () => container.querySelector('.mg-ziwei-detail')!;
    expect(detail().getAttribute('aria-label')).toBe('명궁 기유');
    expect(texts(detail(), 'h2')).toEqual(['명궁기유 己酉']);
    expect(rows(container)).toEqual([
      ['주성', '천부天府왕'],
      ['살성', '지공地空'],
      ['잡성', '함지咸池 | 천수天壽 | 천주天廚 | 천공天空 | 파쇄破碎'],
      ['삼합', '관록 | 재백'],
      ['대궁', '천이'],
      ['12신', '장생 목욕 | 박사 복병 | 장전 함지 | 태세 회기'],
      ['대한', '5–14세'],
      ['소한', '12 | 24 | 36 | 48 | 60 | 72 | 84 | 96 | 108 | 120세'],
      ['비성사화', '록 천이 | 권 복덕 | 과 노복 | 기 자녀'],
    ]);
    expect([...detail().querySelectorAll<HTMLElement>('.mg-ziwei-related button')].map((item) => item.dataset['relation'])).toEqual(['trine', 'trine', 'opposite']);

    await act(async () => cell(container, '관록').click());
    expect(detail().getAttribute('aria-label')).toBe('관록 계축');
    expect(texts(detail(), 'h2')).toEqual(['관록계축 癸丑신궁']);
    expect(rows(container).slice(0, 4)).toEqual([
      ['주성', '천상天相묘'],
      ['보좌·길성', '좌보左輔과 | 우필右弼'],
      ['살성', '지겁地劫'],
      ['잡성', '천희天喜 | 월덕月德'],
    ]);
    expect([...detail().querySelectorAll<HTMLElement>('.mg-ziwei-stars .mg-ziwei-star')].map((star) => star.dataset['kind'])).toEqual(['major', 'lucky', 'lucky', 'tough', 'misc', 'misc']);

    // 지금의 대한인 궁은 그렇다고 적는다.
    await act(async () => cell(container, '전택').click());
    expect(texts(detail(), 'h2 .mg-badge')).toEqual(['현재 대한']);
    // 주성이 없는 궁에는 그 줄이 없다.
    await act(async () => cell(container, '재백').click());
    expect(rows(container).map(([label]) => label)).toEqual(['보좌·길성', '잡성', '삼합', '대궁', '12신', '대한', '소한', '비성사화']);
    await unmount();
  });

  it('삼합과 대궁은 그 궁으로 가는 버튼이고, 누른 버튼은 제자리에 남는다', async () => {
    const { container, unmount } = await mount(panel(garam));
    const related = () => [...container.querySelectorAll<HTMLButtonElement>('.mg-ziwei-related button')];
    expect(related().map((button) => button.textContent)).toEqual(['관록', '재백', '천이']);
    const across = related()[2]!;
    across.focus();
    await act(async () => across.click());
    expect(container.querySelector('.mg-ziwei-detail')?.getAttribute('aria-label')).toBe('천이 계묘');
    expect(pressed(container)).toEqual([cell(container, '천이')]);
    expect(marked(container)).toEqual(['명궁 opposite', '복덕 trine', '천이 self', '부처 trine']);
    // 대궁의 대궁은 떠나온 궁이다: 같은 버튼이 초점을 지닌 채 그 이름을 적는다.
    expect(related().map((button) => button.textContent)).toEqual(['부처', '복덕', '명궁']);
    expect(related()[2]).toBe(across);
    expect(document.activeElement).toBe(across);
    await act(async () => across.click());
    expect(container.querySelector('.mg-ziwei-detail')?.getAttribute('aria-label')).toBe('명궁 기유');
    // 삼합을 따라가면 세 궁을 돈다.
    for (const name of ['관록 계축', '재백 을사', '명궁 기유']) {
      await act(async () => related()[0]!.click());
      expect(container.querySelector('.mg-ziwei-detail')?.getAttribute('aria-label')).toBe(name);
    }
    await unmount();
  });

  it('다른 생일의 명반으로 바뀌면 그 명궁에서 다시 시작한다', async () => {
    const { container, rerender, unmount } = await mount(panel(garam));
    await act(async () => cell(container, '노복').click());
    await rerender(panel(personOf('noeul').birth));
    expect(pressed(container).map((button) => button.getAttribute('aria-label'))).toEqual(['명궁 임인, 탐랑']);
    expect(container.querySelector('.mg-ziwei-detail')?.getAttribute('aria-label')).toBe('명궁 임인');
    expect(container.querySelector('.mg-ziwei-bureau')?.textContent).toBe('금사국');
    await unmount();
  });

  it('태어난 시를 모르면 한 줄뿐이고, 주인에게는 사주 다시 입력이 있다', async () => {
    const unknown = { ...garam, time: null };
    const guest = await mount(panel(unknown));
    expect(guest.container.textContent).toBe('태어난 시간을 알아야 명반을 세울 수 있어요');
    expect(guest.container.querySelectorAll('button, a, h2')).toHaveLength(0);
    await guest.unmount();

    const owner = await mount(panel(unknown, '/@garam/edit'));
    expect(texts(owner.container, 'p')).toEqual(['태어난 시간을 알아야 명반을 세울 수 있어요']);
    const links = [...owner.container.querySelectorAll('a')];
    expect(links.map((link) => [link.getAttribute('href'), link.textContent?.trim()])).toEqual([['/@garam/edit', '사주 다시 입력']]);
    expect(owner.container.querySelectorAll('button, h2')).toHaveLength(0);
    await owner.unmount();
  });
});
