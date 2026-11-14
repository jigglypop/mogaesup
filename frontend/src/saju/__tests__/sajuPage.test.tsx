import { act, type ReactNode } from 'react';

import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import type { Birth } from '../engine';
import type { Frame } from '../scene/frames';
import type { StageBridge, StageHome } from '../scene/Stage';
import { resetSajuStore, sajuStore } from '../store';
import { PLOT_REACH } from '../village';

type StageProps = { homes: StageHome[]; bridges: StageBridge[]; frame: Frame; focus: string | null; onVisit: (id: string) => void; pins?: ReactNode };
const { stage } = vi.hoisted(() => ({ stage: { props: null as StageProps | null } }));

// The canvas needs WebGL; the page around it is what is looked at here.
vi.mock('../scene/Stage', () => ({
  Stage: (props: StageProps) => {
    stage.props = props;
    return <div className="stage">{props.pins}</div>;
  },
}));
vi.mock('../scene/Snapshot', () => ({ Snapshot: () => null }));
vi.mock('../../shell/Shell', () => ({ PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: { displayName: '모개' } }) }));

const { default: SajuPage } = await import('../SajuPage');

const birth: Birth = { calendar: 'solar', year: 1990, month: 2, day: 24, leapMonth: false, time: '12:00', gender: 'female' };

function Where() {
  const { pathname, search } = useLocation();
  return <output>{pathname + search}</output>;
}

describe('사주 마을 화면', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSajuStore();
    stage.props = null;
  });
  afterEach(() => {
    localStorage.clear();
    resetSajuStore();
  });

  const open = (path: string) =>
    mount(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/saju/*" element={<SajuPage />} />
        </Routes>
        <Where />
      </MemoryRouter>,
    );
  const where = (container: HTMLElement) => container.querySelector('output')!.textContent;
  const link = (container: HTMLElement, label: string) => [...container.querySelectorAll('a')].find((anchor) => anchor.textContent?.trim() === label);
  const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  const menu = (container: HTMLElement) =>
    [...container.querySelectorAll('.mg-saju-menu a')].map((anchor) => `${anchor.textContent}${anchor.getAttribute('aria-current') ? '*' : ''} ${anchor.getAttribute('href')}`);

  it('처음 오면 마을 지도와 집 짓는 카드가 있고, 샘플 주민의 집에 바로 갈 수 있다', async () => {
    const { container, unmount } = await open('/saju');
    expect(container.querySelector('h1')?.textContent).toBe('사주 마을');
    expect(container.querySelector('.mg-saju-form h2')?.textContent).toBe('내 집 짓기');
    // 로그인한 이름을 미리 적어 둔다.
    expect(container.querySelector<HTMLInputElement>('input[name=name]')?.value).toBe('모개');
    // 가운데는 빈 터, 네 이웃은 제 방위에 있다.
    expect(stage.props?.homes.map((home) => [home.id, home.x, home.z, !!home.profile])).toEqual([
      ['me', 0, 0, false],
      ['sol', PLOT_REACH, 0, true],
      ['noeul', 0, PLOT_REACH, true],
      ['bori', -PLOT_REACH, 0, true],
      ['garam', 0, -PLOT_REACH, true],
    ]);
    expect(stage.props?.focus).toBeNull();
    expect(stage.props?.frame.target).toEqual([0, 1.5, 0]);
    expect([...container.querySelectorAll<HTMLAnchorElement>('.mg-saju-pin')].map((pin) => `${pin.dataset['pin']} ${pin.getAttribute('href')} ${pin.textContent}`)).toEqual([
      'me /saju 빈 터내 집 짓기',
      'sol /saju/home/sol 솔',
      'noeul /saju/home/noeul 노을',
      'bori /saju/home/bori 보리',
      'garam /saju/home/garam 가람',
    ]);
    expect(menu(container)).toEqual(['홈* /saju', '사주보기 /saju?view=chart', '마을 /saju/village']);
    await unmount();
  });

  it('이웃의 집은 그 섬을 가운데에 두고 사주 요약과 방명록을 보여 준다', async () => {
    const { container, unmount } = await open('/saju/home/noeul');
    expect(container.querySelector('h1')?.textContent).toBe('노을의 미니홈피샘플');
    expect(container.querySelector('.mg-saju-frame')?.getAttribute('data-element')).toBe('fire');
    expect(container.querySelector('.mg-saju-stage')?.getAttribute('data-view')).toBe('home');
    expect(stage.props?.focus).toBe('noeul');
    expect(stage.props?.frame.target).toEqual([0, 1.5, PLOT_REACH]);
    expect(container.querySelector('.mg-saju-badge')?.textContent).toBe('따뜻한 촛불 같은 정화(丁火) 일간');
    expect(container.querySelector('.mg-saju-bgm-title')?.textContent).toBe('정유(丁酉)의 가락 · 치(徵)조');
    expect(container.querySelector('.mg-saju-guestbook h2')?.textContent).toBe('방명록 3');
    // 집이 없으면 다리도 방명록도 집 짓기부터다. 저장하기는 내 집에만 있다.
    expect(container.querySelector('.mg-saju-bridge a')?.getAttribute('href')).toBe('/saju');
    expect(button(container, '내 집 이미지 저장하기')).toBeUndefined();
    expect(link(container, '내 집 짓기')?.getAttribute('href')).toBe('/saju');
    expect(menu(container)).toEqual(['홈* /saju/home/noeul', '사주보기 /saju/home/noeul?view=chart', '마을 /saju/village']);
    // 파도타기는 다음 이웃으로 간다.
    expect(link(container, '파도타기')?.getAttribute('href')).toBe('/saju/home/bori');
    await unmount();
  });

  it('사주보기는 같은 집의 원국을 보여 준다', async () => {
    const { container, unmount } = await open('/saju/home/noeul?view=chart');
    expect(container.querySelector('.mg-saju-pillars')).not.toBeNull();
    expect(container.querySelector('.mg-saju-guestbook')).toBeNull();
    expect(menu(container)[1]).toBe('사주보기* /saju/home/noeul?view=chart');
    await unmount();
  });

  it('내 집에는 저장하기와 고치기가 있고, 집을 지으면 지도 가운데에 선다', async () => {
    sajuStore.moveIn('가온', birth);
    const { container, unmount } = await open('/saju');
    expect(container.querySelector('h1')?.textContent).toBe('가온의 미니홈피');
    expect(container.querySelector('.mg-saju-frame')?.getAttribute('data-element')).toBe('metal');
    expect(stage.props?.focus).toBe('me');
    expect(stage.props?.homes[0]).toMatchObject({ id: 'me', x: 0, z: 0 });
    expect(stage.props?.homes[0]?.profile?.house.style).toBe('metal');
    expect(button(container, '내 집 이미지 저장하기')).toBeDefined();
    expect(container.querySelector('.mg-saju-who-edit')?.getAttribute('href')).toBe('/saju/edit');
    expect(container.querySelector('.mg-saju-bridge')).toBeNull();
    expect(container.querySelector('.mg-saju-guestbook h2')?.textContent).toBe('방명록 2');
    expect(link(container, '내 집')).toBeUndefined();
    await unmount();
  });

  it('다리를 놓으면 두 집을 함께 담고 궁합 한 줄을 말한다', async () => {
    sajuStore.moveIn('가온', birth);
    const { container, unmount } = await open('/saju/home/garam');
    expect(stage.props?.bridges).toEqual([]);
    await act(async () => button(container, '궁합 다리 연결')!.click());
    expect(sajuStore.getState().bridges).toEqual(['garam']);
    expect(stage.props?.bridges.map((bridge) => [bridge.from.id, bridge.to.id, bridge.compat.tone])).toEqual([['me', 'garam', 'flow']]);
    // 내 집(가운데)과 가람의 집(북쪽) 사이가 가운데다.
    expect(stage.props?.frame.target).toEqual([0, 1.5, -PLOT_REACH / 2]);
    expect(container.querySelector('.mg-saju-stage')?.getAttribute('data-view')).toBe('bridge');
    expect(container.querySelector('.mg-saju-say')?.textContent).toBe('금생수(金生水) 시너지! 맑은 생각이 샘솟는 사이');
    expect(container.querySelector('.mg-saju-bridge-line')?.textContent).toBe('금생수(金生水) 시너지! 맑은 생각이 샘솟는 사이');
    await act(async () => button(container, '집 보기')!.click());
    expect(stage.props?.frame.target).toEqual([0, 1.5, -PLOT_REACH]);
    expect(container.querySelector('.mg-saju-say')).toBeNull();
    await unmount();
  });

  it('다른 집에 가면 다리 보기는 끝난다', async () => {
    sajuStore.moveIn('가온', birth);
    sajuStore.connect('garam');
    sajuStore.connect('sol');
    const { container, unmount } = await open('/saju/home/garam');
    await act(async () => button(container, '다리 보기')!.click());
    expect(container.querySelector('.mg-saju-say')).not.toBeNull();
    await act(async () => link(container, '파도타기')!.click());
    expect(where(container)).toBe('/saju/home/sol');
    expect(container.querySelector('.mg-saju-say')).toBeNull();
    expect(stage.props?.frame.target).toEqual([PLOT_REACH, 1.5, 0]);
    await unmount();
  });

  it('마을은 모두를 담고, 섬을 누르면 그 집으로 간다', async () => {
    sajuStore.moveIn('가온', birth);
    sajuStore.connect('sol');
    const { container, unmount } = await open('/saju/village');
    expect(container.querySelector('h1')?.textContent).toBe('사주 마을');
    expect(container.querySelector('.mg-saju-stage')?.getAttribute('data-view')).toBe('village');
    expect([...container.querySelectorAll('.mg-saju-villager b')].map((name) => name.textContent)).toEqual(['가온내 집', '솔샘플다리 놓음', '노을샘플', '보리샘플', '가람샘플']);
    expect(container.querySelector('.mg-saju-pin')?.textContent).toBe('가온내 집');
    expect(menu(container)).toEqual(['홈 /saju', '사주보기 /saju?view=chart', '마을* /saju/village']);
    await act(async () => stage.props!.onVisit('garam'));
    expect(where(container)).toBe('/saju/home/garam');
    await act(async () => stage.props!.onVisit('me'));
    expect(where(container)).toBe('/saju');
    await unmount();
  });

  it('없는 주소는 갈 곳으로 돌린다', async () => {
    const lost = await open('/saju/home/nobody');
    expect(where(lost.container)).toBe('/saju/village');
    await lost.unmount();
    const edit = await open('/saju/edit');
    expect(where(edit.container)).toBe('/saju');
    await edit.unmount();
  });

  it('내 정보 고치기는 지금 정보를 채워 보여 준다', async () => {
    sajuStore.moveIn('가온', birth);
    const { container, unmount } = await open('/saju/edit');
    expect(container.querySelector('.mg-saju-form h2')?.textContent).toBe('내 정보 고치기');
    expect(container.querySelector<HTMLInputElement>('input[name=year]')?.value).toBe('1990');
    expect(stage.props?.focus).toBe('me');
    await unmount();
  });
});
