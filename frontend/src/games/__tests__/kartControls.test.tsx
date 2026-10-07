import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import type { GameProps } from '../game';
import type { KartView } from '../kart';
import { KartOverlay } from '../kart/Overlay';
import { createKartTouchControls, kartTouchControls, readKartInput } from '../kart/controls';

const idle = { throttle: 0, steer: 0, drift: false };
const NOW = 900_000;
const game = (changes: Partial<KartView> = {}): KartView => ({
  phase: 'race', startsAt: NOW - 5000, endsAt: NOW + 300_000, laps: 3, gates: 54,
  racers: [{ id: 'me', name: '나', bot: false, color: 0, lap: 0, next: 1, finishedAt: null, rank: 1, boostUntil: 0, trappedUntil: 0 }],
  me: { lap: 0, next: 1, item: 'booster' }, spawn: [0, 0, 0], boxes: [], boosts: [], bots: [], ...changes,
});
const mounted: Awaited<ReturnType<typeof mount>>[] = [];
let media: EventTarget & { matches: boolean; media: string };

async function overlay(shown = game(), you = 'me') {
  const me = { id: you, name: '나', peer: null };
  const given = {
    session: {
      id: 1, kind: 'kart', phase: 'playing', startedAt: NOW - 5000, canClose: true, host: 'me', players: [me], you,
      home: null, stand: null, game: shown, result: null, seq: 1, now: NOW,
    },
    view: shown, me, act: vi.fn(() => true), onEvent: () => () => {}, serverNow: () => NOW,
    teleport: () => true, position: () => null, body: () => null, trip: () => null, setTrip: () => {},
  } satisfies GameProps<KartView>;
  const view = await mount(<KartOverlay {...given} />);
  mounted.push(view);
  const control = (name: string) => view.container.querySelector<HTMLButtonElement>(`[data-control="${name}"]`)!;
  return { ...view, control, act: given.act, show: (next: KartView) => view.rerender(<KartOverlay {...given} view={next} />) };
}

async function pointer(target: EventTarget, type: string, id: number, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button });
  Object.defineProperty(event, 'pointerId', { value: id });
  await act(() => { target.dispatchEvent(event); });
}

describe('카트 터치 입력', () => {
  beforeEach(() => {
    kartTouchControls.reset();
    media = Object.assign(new EventTarget(), { matches: true, media: '(pointer: coarse), (max-width: 720px)' });
    vi.stubGlobal('matchMedia', vi.fn(() => media));
  });
  afterEach(async () => {
    for (const view of mounted.splice(0)) if (view.container.isConnected) await view.unmount();
    kartTouchControls.reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('같은 버튼을 누른 두 손가락 중 하나를 떼어도 나머지 입력을 유지한다', () => {
    const controls = createKartTouchControls(), changed = vi.fn(), stop = controls.subscribe(changed);
    controls.press('forward', 1); controls.press('forward', 2);
    const down = controls.getSnapshot();
    expect(changed).toHaveBeenCalledTimes(1);
    controls.release(1);
    expect(controls.getSnapshot()).toBe(down);
    expect(controls.getSnapshot().forward).toBe(true);
    controls.release(2);
    expect(controls.getSnapshot().forward).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    stop(); controls.press('drift', 3);
    expect(changed).toHaveBeenCalledTimes(2);
    controls.reset();
    expect(Object.values(controls.getSnapshot()).some(Boolean)).toBe(false);
  });

  it('키보드와 터치의 같은 방향은 합치고 반대 방향은 상쇄한다', () => {
    kartTouchControls.press('forward', 1); kartTouchControls.press('right', 2); kartTouchControls.press('drift', 3);
    expect(readKartInput(new Set(['KeyW', 'ArrowRight']))).toEqual({ throttle: 1, steer: 1, drift: true });
    expect(readKartInput(new Set(['KeyS', 'ArrowLeft']))).toEqual({ throttle: 0, steer: 0, drift: true });
    kartTouchControls.release(3);
    expect(readKartInput(new Set(['ShiftLeft']))).toEqual({ throttle: 1, steer: 1, drift: true });
    kartTouchControls.reset();
    expect(readKartInput(new Set())).toEqual(idle);
  });

  it('왼손 조향과 브레이크, 오른손 가속과 드리프트를 나누고 네 방향키를 유지한다', async () => {
    const shown = await overlay();
    const names = (selector: string) => [...shown.container.querySelectorAll(`${selector} [data-control]`)].map(button => button.getAttribute('aria-label'));
    expect(names('.mg-kart-touch-pad')).toEqual(['뒤로', '왼쪽', '오른쪽']);
    expect(names('.mg-kart-touch-actions')).toEqual(['드리프트', '앞으로']);
    expect(shown.container.querySelectorAll('.mg-kart-control')).toHaveLength(5);
    expect(shown.container.querySelectorAll('.mg-kart-item')).toHaveLength(1);
    // The separate groups still own separate keyboard holds.
    await act(() => shown.control('forward').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await act(() => shown.control('back').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(readKartInput(new Set()).throttle).toBe(0);
    await act(() => shown.control('back').dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })));
    expect(readKartInput(new Set()).throttle).toBe(1);
  });

  it('가속·좌회전·드리프트를 동시에 누르고, 화면 밖에서 뗀 손가락만 풀며 아이템도 쓴다', async () => {
    const shown = await overlay();
    await pointer(shown.control('forward'), 'pointerdown', 1);
    await pointer(shown.control('left'), 'pointerdown', 2);
    await pointer(shown.control('drift'), 'pointerdown', 3);
    expect(readKartInput(new Set())).toEqual({ throttle: 1, steer: -1, drift: true });
    expect(['forward', 'left', 'drift'].map(name => shown.control(name).getAttribute('aria-pressed'))).toEqual(['true', 'true', 'true']);
    await act(() => shown.container.querySelector<HTMLButtonElement>('.mg-kart-item')!.click());
    expect(shown.act).toHaveBeenCalledExactlyOnceWith({ do: 'item' });
    await pointer(window, 'pointerup', 2);
    expect(readKartInput(new Set())).toEqual({ throttle: 1, steer: 0, drift: true });
    await pointer(window, 'pointercancel', 1);
    await pointer(shown.control('drift'), 'lostpointercapture', 3);
    expect(readKartInput(new Set())).toEqual(idle);
    await pointer(shown.control('back'), 'pointerdown', 4);
    expect(readKartInput(new Set()).throttle).toBe(-1);
    await pointer(shown.control('back'), 'pointerup', 4);
    await pointer(shown.control('right'), 'pointerdown', 5, 2);
    expect(readKartInput(new Set())).toEqual(idle);
  });

  it('창 포커스와 탭을 잃으면 남아 있는 모든 손가락을 해제한다', async () => {
    const shown = await overlay();
    await pointer(shown.control('forward'), 'pointerdown', 1);
    await pointer(shown.control('right'), 'pointerdown', 2);
    await act(() => window.dispatchEvent(new Event('blur')));
    expect(readKartInput(new Set())).toEqual(idle);
    await pointer(shown.control('forward'), 'pointerdown', 3);
    await pointer(shown.control('drift'), 'pointerdown', 4);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(readKartInput(new Set())).toEqual(idle);
  });

  it('대기·완주·경기 종료에는 조작하지 못하고 전환 전에 누른 입력도 해제한다', async () => {
    const shown = await overlay(game({ phase: 'countdown', startsAt: NOW + 3000 }));
    expect(shown.control('forward').disabled).toBe(true);
    await pointer(shown.control('forward'), 'pointerdown', 1);
    expect(readKartInput(new Set())).toEqual(idle);
    await shown.show(game());
    await pointer(shown.control('forward'), 'pointerdown', 2);
    await shown.show(game({ phase: 'countdown' }));
    expect(readKartInput(new Set())).toEqual(idle);
    await shown.show(game());
    await pointer(shown.control('forward'), 'pointerdown', 2);
    await shown.show(game({ racers: [{ ...game().racers[0]!, finishedAt: 12_000 }] }));
    expect(shown.container.querySelector('.mg-kart-touch')).toBeNull();
    expect(readKartInput(new Set())).toEqual(idle);
    await shown.show(game());
    await pointer(shown.control('drift'), 'pointerdown', 3);
    await shown.show(game({ phase: 'ended' }));
    expect(shown.container.innerHTML).toBe('');
    expect(readKartInput(new Set())).toEqual(idle);
  });

  it('모바일 조건이 사라지거나 화면이 내려가면 입력과 전역 구독을 해제한다', async () => {
    const shown = await overlay();
    expect(matchMedia).toHaveBeenCalledWith('(pointer: coarse), (max-width: 720px)');
    await pointer(shown.control('forward'), 'pointerdown', 1);
    await act(() => { media.matches = false; media.dispatchEvent(new Event('change')); });
    expect(shown.container.querySelector('.mg-kart-touch')).toBeNull();
    expect(readKartInput(new Set())).toEqual(idle);
    await act(() => { media.matches = true; media.dispatchEvent(new Event('change')); });
    await pointer(shown.control('drift'), 'pointerdown', 2);
    await shown.unmount();
    expect(readKartInput(new Set())).toEqual(idle);
    kartTouchControls.press('forward', 3);
    window.dispatchEvent(new Event('blur'));
    expect(readKartInput(new Set()).throttle).toBe(1);
  });

  it('데스크톱이나 관전 중에는 터치 버튼을 만들지 않는다', async () => {
    media.matches = false;
    const desktop = await overlay();
    expect(desktop.container.querySelector('.mg-kart-touch')).toBeNull();
    media.matches = true;
    const watcher = await overlay(game({ me: null }), 'watcher');
    expect(watcher.container.querySelector('.mg-kart-touch')).toBeNull();
  });

  it('Enter를 누르고 있는 동안 조작하며 버튼 포커스를 잃으면 해제한다', async () => {
    const shown = await overlay(), button = shown.control('forward');
    await act(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(readKartInput(new Set()).throttle).toBe(1);
    await act(() => button.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })));
    expect(readKartInput(new Set())).toEqual(idle);
    await act(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await act(() => button.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(readKartInput(new Set())).toEqual(idle);
  });
});
