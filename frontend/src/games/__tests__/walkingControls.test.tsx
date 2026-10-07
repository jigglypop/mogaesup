import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({ updateKeyboard: vi.fn(), scope: null as unknown as import('gaesup-world').WorldInputScope }));
vi.mock('gaesup-world', async (original) => {
  const actual = await original<typeof import('gaesup-world')>();
  return { createWorldInputScope: actual.createWorldInputScope, useInteractionSystem: () => engine, useWorldInputScope: () => engine.scope };
});

import { createWorldInputScope } from 'gaesup-world';
import { mount } from '../../__tests__/mount';
import { WalkingControls } from '../WalkingControls';

const released = { forward: false, backward: false, leftward: false, rightward: false };
let shown: Awaited<ReturnType<typeof mount>>;
let media: EventTarget & { matches: boolean };
let canvas: HTMLCanvasElement;
let stop: (() => void)[];
const directions = { KeyW: 'forward', ArrowUp: 'forward', KeyS: 'backward', ArrowDown: 'backward',
  KeyA: 'leftward', ArrowLeft: 'leftward', KeyD: 'rightward', ArrowRight: 'rightward' } as const;
const state = () => engine.updateKeyboard.mock.lastCall?.[0] ?? released;
async function pointer(target: EventTarget, type: string, id: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: id });
  await act(() => target.dispatchEvent(event));
}
const button = (direction: string) => shown.container.querySelector<HTMLButtonElement>(`[data-direction=${direction}]`)!;

describe('임포스터 모바일 이동', () => {
  beforeEach(async () => {
    engine.updateKeyboard.mockClear();
    const scope = createWorldInputScope(); engine.scope = scope;
    const keys = new Map<string, keyof typeof released>();
    const publish = () => {
      const next = { ...released };
      for (const direction of keys.values()) next[direction] = true;
      engine.updateKeyboard(next);
    };
    // The controller keeps physical and virtual eventSource ownership separately in the same world scope.
    stop = [scope.listen('keydown', event => {
      const direction = directions[event.code as keyof typeof directions];
      if (direction) { keys.set(scope.eventSource(event), direction); publish(); }
    }), scope.listen('keyup', event => {
      if (keys.delete(scope.eventSource(event))) publish();
    }), scope.onBlur(() => { if (keys.size) { keys.clear(); publish(); } })];
    canvas = document.createElement('canvas'); document.body.append(canvas);
    stop.push(scope.registerSurface(canvas));
    await pointer(canvas, 'pointerdown', 99);
    media = Object.assign(new EventTarget(), { matches: true });
    vi.stubGlobal('matchMedia', () => media);
    shown = await mount(<WalkingControls />);
  });
  afterEach(async () => {
    if (shown.container.isConnected) await shown.unmount();
    stop.forEach(remove => remove()); canvas.remove();
    vi.unstubAllGlobals(); vi.restoreAllMocks();
  });
  it('두 방향을 동시에 입력하고 손가락별로 해제한다', async () => {
    await pointer(button('forward'), 'pointerdown', 1);
    await pointer(button('forward'), 'pointerdown', 2);
    await pointer(button('leftward'), 'pointerdown', 3);
    expect(state()).toEqual({ ...released, forward: true, leftward: true });
    await pointer(window, 'pointerup', 1);
    expect(state().forward).toBe(true);
    await pointer(window, 'pointercancel', 3);
    expect(state()).toEqual({ ...released, forward: true });
    await pointer(button('forward'), 'lostpointercapture', 2);
    expect(state()).toEqual(released);
  });
  it('터치를 떼어도 물리 키보드의 방향 입력은 유지한다', async () => {
    await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })));
    await pointer(button('rightward'), 'pointerdown', 1);
    expect(state()).toEqual({ ...released, forward: true, rightward: true });
    await pointer(window, 'pointerup', 1);
    expect(state()).toEqual({ ...released, forward: true });
  });
  it('회의·작업 상태로 전환하면 누른 방향을 풀고 새 입력을 막는다', async () => {
    await pointer(button('forward'), 'pointerdown', 1);
    await shown.rerender(<WalkingControls disabled />);
    expect(state()).toEqual(released);
    expect(button('forward').disabled).toBe(true);
    await pointer(button('forward'), 'pointerdown', 2);
    expect(state()).toEqual(released);
  });
  it('포커스·모바일 조건·화면이 사라지면 엔진 입력을 해제한다', async () => {
    await pointer(button('forward'), 'pointerdown', 1);
    await act(() => window.dispatchEvent(new Event('blur')));
    expect(state()).toEqual(released);
    await pointer(button('rightward'), 'pointerdown', 2);
    await act(() => { media.matches = false; media.dispatchEvent(new Event('change')); });
    expect(shown.container.innerHTML).toBe('');
    expect(state()).toEqual(released);
  });
  it('실제 world scope에서 W를 누른 채 터치를 놓고 W를 놓아도 이동이 남지 않는다', async () => {
    await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true })));
    await pointer(button('rightward'), 'pointerdown', 1);
    await pointer(window, 'pointerup', 1);
    expect(state()).toEqual({ ...released, forward: true });
    await act(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true })));
    expect(state()).toEqual(released);
  });
  it('같은 방향의 물리 키를 놓아도 터치 소유권은 남고 터치를 놓으면 끝난다', async () => {
    await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true })));
    await pointer(button('forward'), 'pointerdown', 1);
    await act(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true })));
    expect(state()).toEqual({ ...released, forward: true });
    await pointer(window, 'pointerup', 1);
    expect(state()).toEqual(released);
  });
  it('다른 world와 입력 필드에 키를 넘기면 터치를 해제하고 전역 키를 덮지 않는다', async () => {
    const foreign = createWorldInputScope(), surface = document.createElement('canvas'); document.body.append(surface);
    const foreignKeys = vi.fn();
    const remove = [foreign.registerSurface(surface), foreign.listen('keydown', foreignKeys)];
    try {
      await pointer(button('rightward'), 'pointerdown', 1);
      await pointer(surface, 'pointerdown', 2);
      expect(state()).toEqual(released);
      const writes = engine.updateKeyboard.mock.calls.length;
      await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true })));
      await act(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true })));
      expect(foreignKeys).toHaveBeenCalledOnce();
      expect(engine.updateKeyboard.mock.calls.length).toBe(writes);
      await pointer(window, 'pointerup', 1);
      await pointer(button('rightward'), 'pointerdown', 3);
      const field = document.createElement('input'); document.body.append(field);
      try {
        await act(() => field.focus());
        expect(state()).toEqual(released);
        const typedWrites = engine.updateKeyboard.mock.calls.length;
        await act(() => field.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true })));
        await act(() => field.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true })));
        expect(engine.updateKeyboard.mock.calls.length).toBe(typedWrites);
      } finally { field.remove(); }
    } finally { remove.forEach(detach => detach()); surface.remove(); }
  });
  it('disabled는 터치만 해제하고 물리 키는 정상적으로 마지막 keyup까지 처리한다', async () => {
    await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true })));
    await pointer(button('rightward'), 'pointerdown', 1);
    await shown.rerender(<WalkingControls disabled />);
    expect(state()).toEqual({ ...released, forward: true });
    await pointer(button('forward'), 'pointerdown', 2);
    await act(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true })));
    expect(state()).toEqual(released);
  });
  it('탭이 숨겨지거나 화면이 내려가면 가상 키를 해제한다', async () => {
    await pointer(button('forward'), 'pointerdown', 1);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(state()).toEqual(released);
    await pointer(button('rightward'), 'pointerdown', 2);
    await shown.unmount();
    expect(state()).toEqual(released);
  });
  it('버튼의 Enter 입력도 blur에서 해제한다', async () => {
    await act(() => button('forward').focus());
    await act(() => button('forward').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })));
    expect(state()).toEqual({ ...released, forward: true });
    await act(() => button('forward').blur());
    expect(state()).toEqual(released);
  });
});
