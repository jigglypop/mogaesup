import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import type { ImpostorEvent, ImpostorView } from '../impostor';
import { ImpostorOverlay } from '../impostor/Overlay';
import { routeAt } from '../impostor/route';
import { game, NOW, props } from './impostorView';

const mounted: { unmount: () => Promise<void> }[] = [];

async function overlay(shown: ImpostorView, you = 'me') {
  const given = props(shown, you);
  let hear: (event: unknown) => void = () => {};
  given.onEvent = (listener: (event: unknown) => void) => {
    hear = listener;
    return () => {};
  };
  const view = await mount(<ImpostorOverlay {...given} />);
  mounted.push(view);
  const buttons = () => [...view.container.querySelectorAll('button')];
  const button = (name: string) => buttons().find((item) => item.textContent?.trim().startsWith(name) || item.getAttribute('aria-label') === name);
  const press = (name: string) => act(() => button(name)!.click());
  const show = (next: ImpostorView) => view.rerender(<ImpostorOverlay {...given} view={next} />);
  const announce = (event: ImpostorEvent) => act(() => hear(event));
  const splash = () => view.container.querySelector('.mg-impostor-splash')?.textContent ?? null;
  return { view, act: given.act, buttons, button, press, show, announce, splash };
}

describe('임포스터가 섬 위에 두는 것', () => {
  afterEach(async () => {
    for (const view of mounted.splice(0)) await view.unmount();
    vi.useRealTimers();
  });

  it('시작하면 받은 편을 크게 보여 주고 잠시 뒤 사라진다', async () => {
    vi.useFakeTimers();
    const crew = await overlay(game());
    expect(crew.splash()).toBe('크루');
    await act(() => vi.advanceTimersByTime(3_300));
    expect(crew.splash()).toBeNull();
    const impostor = await overlay(game({ role: 'impostor', impostors: ['me', 'c'] }));
    expect(impostor.splash()).toBe('임포스터동료 씨');
  });

  it('크루는 가까이 있는 것만 누를 수 있다: 작업, 신고, 긴급 회의', async () => {
    const { button, press, show, act: sent } = await overlay(game());
    expect(['작업', '신고', '긴급 회의'].map((name) => button(name)!.disabled)).toEqual([true, true, true]);
    expect(button('처치')).toBeUndefined();
    expect(button('환풍구')).toBeUndefined();
    expect(button('정전')).toBeUndefined();
    await show(game({ near: { station: 5, body: 2, table: true, vent: null, panel: false } }));
    await press('작업');
    expect(sent).toHaveBeenLastCalledWith({ do: 'task' });
    await press('신고');
    expect(sent).toHaveBeenLastCalledWith({ do: 'report', body: 2 });
    await press('긴급 회의');
    expect(sent).toHaveBeenLastCalledWith({ do: 'meeting' });
    // Too soon after a meeting, while something is broken, and once it is spent.
    await show(game({ near: { station: null, body: null, table: true, vent: null, panel: false }, emergencyFrom: NOW + 9_000 }));
    expect(button('긴급 회의')!.textContent).toBe('긴급 회의 9');
    expect(button('긴급 회의')!.disabled).toBe(true);
    await show(game({ near: { station: null, body: null, table: true, vent: null, panel: false }, sabotage: { kind: 'lights', endsAt: null, held: [false, false] } }));
    expect(button('긴급 회의')!.disabled).toBe(true);
    await show(game({ near: { station: null, body: null, table: true, vent: null, panel: false }, emergencyLeft: 0 }));
    expect(button('긴급 회의')).toBeUndefined();
  });

  it('작업을 시작하면 그 종류의 작업 화면이 뜨고, 풀고 시간이 지나야 끝을 보내며, 닫으면 그만둔다', async () => {
    vi.useFakeTimers();
    const working = game({ working: { station: 3, kind: 'numbers', readyAt: NOW + 2_000 } });
    const shown = await overlay(working);
    const dialog = shown.view.container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe('숫자 누르기');
    expect(shown.button('작업')!.disabled).toBe(true);
    // One to ten in order; a wrong one starts over.
    // By their exact number: '1' must not find '10'.
    const number = (value: number) => shown.buttons().find((item) => item.textContent === String(value))!;
    await act(() => number(2).click());
    expect(number(1).getAttribute('aria-pressed')).toBe('false');
    for (let value = 1; value <= 10; value++) await act(() => number(value).click());
    expect(dialog.querySelector('[role="status"]')!.textContent).toBe('완료');
    expect(shown.act).not.toHaveBeenCalledWith({ do: 'finish' });
    // The server's clock reaches the task's time: finish, once.
    const later = props(working);
    later.serverNow = () => NOW + 2_000;
    await shown.view.rerender(<ImpostorOverlay {...later} act={shown.act} />);
    await act(() => vi.advanceTimersByTime(200));
    expect(shown.act).toHaveBeenCalledWith({ do: 'finish' });
    expect(shown.act.mock.calls.filter(([action]) => (action as { do: string }).do === 'finish')).toHaveLength(1);
    // Keys work the task, not the island; Escape puts it down.
    const heard = vi.fn();
    document.addEventListener('keydown', heard);
    await act(() => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true })));
    expect(heard).not.toHaveBeenCalled();
    await act(() => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(shown.act).toHaveBeenLastCalledWith({ do: 'stop' });
    document.removeEventListener('keydown', heard);
    await shown.press('작업 그만두기');
    expect(shown.act).toHaveBeenLastCalledWith({ do: 'stop' });
  });

  it('전선은 같은 색끼리 이어야 하고, 넷을 다 이으면 풀린다', async () => {
    const shown = await overlay(game({ working: { station: 0, kind: 'wires', readyAt: NOW - 1 } }));
    const wire = (side: string, index: number) => shown.button(`${side} ${index}`)!;
    // A wrong pair joins nothing.
    await act(() => wire('왼쪽', 1).click());
    await act(() => wire('오른쪽', 2).click());
    expect(shown.view.container.querySelectorAll('line')).toHaveLength(0);
    for (const index of [1, 2, 4, 6]) {
      await act(() => wire('왼쪽', index).click());
      await act(() => wire('오른쪽', index).click());
    }
    expect(shown.view.container.querySelectorAll('line')).toHaveLength(4);
    expect(shown.act).toHaveBeenCalledWith({ do: 'finish' });
  });

  it('임포스터는 기다린 뒤 가장 가까운 크루를 처치하고, 환풍구를 드나들고, 사보타주를 고른다', async () => {
    const impostor = game({ role: 'impostor', impostors: ['me'], kill: { readyAt: NOW + 12_000, targets: ['b'] }, sabotageFrom: NOW + 4_000 });
    const { button, press, show, buttons, act: sent } = await overlay(impostor);
    expect(button('작업')).toBeUndefined();
    expect(button('처치')!.textContent).toBe('처치 12');
    expect(button('처치')!.disabled).toBe(true);
    expect(['정전', '통신 방해', '원자로'].map((name) => button(name)!.disabled)).toEqual([true, true, true]);
    await show({ ...impostor, kill: { readyAt: NOW - 1, targets: ['b', 'd'] }, sabotageFrom: NOW - 1 });
    expect(button('처치')!.textContent).toBe('처치 · 비');
    await press('처치');
    expect(sent).toHaveBeenLastCalledWith({ do: 'kill', target: 'b' });
    await press('원자로');
    expect(sent).toHaveBeenLastCalledWith({ do: 'sabotage', kind: 'reactor' });
    // A vent in reach; inside, only the other vents and the way out.
    expect(button('환풍구')!.disabled).toBe(true);
    await show({ ...impostor, near: { station: null, body: null, table: false, vent: 1, panel: false } });
    await press('환풍구');
    expect(sent).toHaveBeenLastCalledWith({ do: 'vent' });
    await show({ ...impostor, venting: 1, vents: [[0, 0, 0], [10, 0, 0], [20, 0, 0]] });
    expect(buttons().map((item) => item.textContent).slice(0, 3)).toEqual(['환풍구 1', '환풍구 3', '나가기']);
    expect(button('처치')).toBeUndefined();
    expect(button('신고')).toBeUndefined();
    await press('환풍구 3');
    expect(sent).toHaveBeenLastCalledWith({ do: 'vent', to: 2 });
    await press('나가기');
    expect(sent).toHaveBeenLastCalledWith({ do: 'vent' });
  });

  it('고장 나면 무엇이 고장인지와 원자로의 남은 시간이 보이고, 그 패널에서 고친다; 정전이면 크루는 어둡다', async () => {
    const reactor = game({ sabotage: { kind: 'reactor', endsAt: NOW + 31_000, held: [true, false] } });
    const { view: shown, button, press, show, act: sent } = await overlay(reactor);
    const alarm = shown.container.querySelector('.mg-impostor-alarm')!;
    expect(alarm.querySelector('b')!.textContent).toBe('원자로');
    expect(alarm.querySelector('.mg-game-timer')!.textContent).toBe('0:31');
    expect([...alarm.querySelectorAll('.mg-impostor-held i')].map((dot) => dot.hasAttribute('data-held'))).toEqual([true, false]);
    expect(button('고치기')).toBeUndefined();
    await show({ ...reactor, near: { station: null, body: null, table: false, vent: null, panel: true } });
    await press('고치기');
    expect(sent).toHaveBeenLastCalledWith({ do: 'fix' });
    expect(shown.container.querySelector('.mg-impostor-dark')).toBeNull();
    await show(game({ sabotage: { kind: 'lights', endsAt: null, held: [false, false] } }));
    expect(shown.container.querySelector('.mg-impostor-alarm .mg-game-timer')).toBeNull();
    expect(shown.container.querySelector('.mg-impostor-dark')).not.toBeNull();
    // Impostors and the dead see in the dark.
    await show(game({ role: 'impostor', sabotage: { kind: 'lights', endsAt: null, held: [false, false] } }));
    expect(shown.container.querySelector('.mg-impostor-dark')).toBeNull();
    await show(game({ alive: false, sabotage: { kind: 'lights', endsAt: null, held: [false, false] } }));
    expect(shown.container.querySelector('.mg-impostor-dark')).toBeNull();
  });

  it('처치, 회의, 판정이 오면 크게 알린다', async () => {
    vi.useFakeTimers();
    const shown = await overlay(game());
    await act(() => vi.advanceTimersByTime(4_000));
    await shown.announce({ type: 'killed' });
    expect(shown.splash()).toBe('처치당했어요');
    await shown.announce({ type: 'meeting', number: 1, reason: 'report', caller: 'b', victim: 'd' });
    expect(shown.splash()).toBe('시체 발견비');
    await shown.announce({ type: 'verdict', number: 1, ejected: 'c', name: '씨', impostor: false });
    expect(shown.splash()).toBe('씨님은 임포스터가 아니었어요');
    await shown.announce({ type: 'verdict', number: 2, ejected: null, name: null, impostor: null });
    expect(shown.splash()).toBe('아무도 추방되지 않았어요');
  });

  it('구경하는 사람에게는 누를 것이 없다', async () => {
    const shown = await overlay(game({ role: null, alive: null, tasks: [], emergencyLeft: 0 }), 'watcher');
    expect(shown.buttons()).toEqual([]);
  });
});

describe('봇의 길', () => {
  it('서버처럼 점을 따라 정해진 빠르기로 걷고, 끝에 서 있다', () => {
    const route = { points: [[0, 0, 0], [3, 0, 0], [3, 0, 6]] as [number, number, number][], departAt: 1_000, speed: 3 };
    expect(routeAt(route, 0)).toEqual([0, 0, 0]);
    expect(routeAt(route, 1_500)).toEqual([1.5, 0, 0]);
    expect(routeAt(route, 3_000)).toEqual([3, 0, 3]);
    expect(routeAt(route, 9_000)).toEqual([3, 0, 6]);
    expect(routeAt({ points: [[1, 0, 2]], departAt: 0, speed: 3 }, 99)).toEqual([1, 0, 2]);
  });
});
