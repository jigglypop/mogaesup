import { act, useCallback, type ReactElement, type ReactNode, type RefObject } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import type { Build } from '../scene/build';
import { frameOf, ZOOM_RANGE } from '../scene/frames';
import { useBuild, WorksContext, type Works } from '../scene/works';

const { canvas } = vi.hoisted(() => ({ canvas: { children: null as ReactNode } }));
// The canvas needs WebGL. What is looked at here is what the box around it hears of the pointer, the wheel and the
// fingers, and what it tells the scene: how far the camera is turned and zoomed.
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: ReactNode }) => {
    canvas.children = children;
    return <canvas />;
  },
  useFrame: () => undefined,
  useThree: () => undefined,
}));
vi.mock('@react-three/postprocessing', () => ({}));

const { Stage } = await import('../scene/Stage');

type Told = { turn: RefObject<number>; zoom: RefObject<number> };
/** What the stage has told its scene. */
const told = () => (canvas.children as ReactElement<Told>[])[0]!.props;

describe('캔버스가 듣는 손짓', () => {
  let page: Awaited<ReturnType<typeof mount>>;
  let box: HTMLElement;
  const point = (type: string, init: PointerEventInit) => act(async () => void box.querySelector('canvas')!.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init })));
  const wheel = (deltaY: number, init: WheelEventInit = {}) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, ...init });
    box.querySelector('canvas')!.dispatchEvent(event);
    return event;
  };
  /** One of the events Safari sends for a trackpad's pinch. */
  const gesture = (type: string, scale: number) => {
    const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale });
    box.querySelector('canvas')!.dispatchEvent(event);
    return event;
  };

  beforeEach(async () => {
    // jsdom keeps no pointer for an element.
    HTMLElement.prototype.setPointerCapture = () => undefined;
    page = await mount(<Stage homes={[{ id: 'sol', x: 0, z: 0, profile: null }]} bridges={[]} frame={frameOf([{ x: 0, z: 0 }])} focus={null} />);
    box = page.container.querySelector<HTMLElement>('.mg-saju-canvas')!;
  });
  afterEach(() => page.unmount());

  it('끌면 카메라가 돌고, 놓으면 끝난다', async () => {
    await point('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 300 });
    await point('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 340 });
    expect(told().turn.current).toBeCloseTo(-40 * 0.0026, 10);
    expect(box.dataset['turning']).toBe('');
    await point('pointerup', { pointerId: 1, pointerType: 'mouse', clientX: 340 });
    expect(box.dataset['turning']).toBeUndefined();
  });

  it('둘째 손가락이 닿으면 끌기가 끝난다: 잡은 표시도 남지 않는다', async () => {
    await point('pointerdown', { pointerId: 1, pointerType: 'touch', buttons: 1, clientX: 300, clientY: 400 });
    await point('pointermove', { pointerId: 1, pointerType: 'touch', buttons: 1, clientX: 320, clientY: 400 });
    expect(box.dataset['turning']).toBe('');
    await point('pointerdown', { pointerId: 2, pointerType: 'touch', buttons: 1, clientX: 420, clientY: 400 });
    expect(box.dataset['turning']).toBeUndefined();
    // 두 손가락이 벌어진 만큼 당겨지고, 카메라는 더 돌지 않는다.
    const turned = told().turn.current;
    await point('pointermove', { pointerId: 2, pointerType: 'touch', buttons: 1, clientX: 520, clientY: 400 });
    expect(told().zoom.current).toBeCloseTo(2, 10);
    expect(told().turn.current).toBe(turned);
    await point('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 520, clientY: 400 });
    await point('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 320, clientY: 400 });
    expect(box.dataset['turning']).toBeUndefined();
  });

  it.each(['mouse', 'pen'])('%s: 다른 데서 뗀 뒤 누르지 않고 지나가기만 해서는 카메라가 돌지 않는다', async (pointerType) => {
    // 그림에서 누르고, 뗀 것은 이 상자가 듣지 못했다.
    await point('pointerdown', { pointerId: 5, pointerType, button: 0, buttons: 1, clientX: 300 });
    await point('pointermove', { pointerId: 5, pointerType, buttons: 0, clientX: 380 });
    await point('pointermove', { pointerId: 5, pointerType, buttons: 0, clientX: 460 });
    expect(told().turn.current).toBe(0);
    expect(box.dataset['turning']).toBeUndefined();
    // 다시 눌러 끌면 돈다.
    await point('pointerdown', { pointerId: 5, pointerType, button: 0, buttons: 1, clientX: 300 });
    await point('pointermove', { pointerId: 5, pointerType, buttons: 1, clientX: 320 });
    expect(told().turn.current).toBeCloseTo(-20 * 0.0026, 10);
  });

  it('휠은 페이지 대신 그림을 당기고, ctrl을 누른 한 칸도 한 칸만큼만 당긴다', () => {
    expect(wheel(-100).defaultPrevented).toBe(true);
    expect(told().zoom.current).toBeCloseTo(Math.exp(0.16), 10);
    wheel(100);
    expect(told().zoom.current).toBeCloseTo(1, 10);
    // 트랙패드의 핀치: ctrl과 함께 오는 잔걸음.
    wheel(-4, { ctrlKey: true });
    expect(told().zoom.current).toBeCloseTo(Math.exp(0.048), 10);
    wheel(4, { ctrlKey: true });
    // ctrl을 누르고 돌린 마우스 휠.
    wheel(-100, { ctrlKey: true });
    expect(told().zoom.current).toBeCloseTo(Math.exp(0.16), 10);
    // 줄 단위로 오는 휠.
    wheel(3, { deltaMode: WheelEvent.DOM_DELTA_LINE });
    expect(told().zoom.current).toBeCloseTo(Math.exp(0.16 - 48 * 0.0016), 10);
    // 끝에서 멈춘다.
    for (let notch = 0; notch < 20; notch++) wheel(100);
    expect(told().zoom.current).toBe(ZOOM_RANGE.min);
  });

  it('사파리가 따로 알리는 트랙패드 핀치로도 그림을 당긴다', () => {
    expect(gesture('gesturestart', 1).defaultPrevented).toBe(true);
    expect(gesture('gesturechange', 1.1).defaultPrevented).toBe(true);
    expect(told().zoom.current).toBeCloseTo(1.1, 10);
    gesture('gesturechange', 1.5);
    expect(told().zoom.current).toBeCloseTo(1.5, 10);
    // 새 핀치는 다시 1에서 센다.
    gesture('gesturestart', 1);
    gesture('gesturechange', 0.8);
    expect(told().zoom.current).toBeCloseTo(1.2, 10);
  });

  it('화면에 닿은 두 손가락은 포인터로 듣는다: 같은 핀치를 두 번 세지 않는다', async () => {
    await point('pointerdown', { pointerId: 1, pointerType: 'touch', buttons: 1, clientX: 300, clientY: 400 });
    await point('pointerdown', { pointerId: 2, pointerType: 'touch', buttons: 1, clientX: 400, clientY: 400 });
    gesture('gesturestart', 1);
    await point('pointermove', { pointerId: 2, pointerType: 'touch', buttons: 1, clientX: 450, clientY: 400 });
    expect(gesture('gesturechange', 1.5).defaultPrevented).toBe(true);
    expect(told().zoom.current).toBeCloseTo(1.5, 10);
  });
});

/** An island that says when it has been built. What builds it stays the same from one render to the next, as a home's does. */
function Island({ name, turn, built }: { name: string; turn: number; built: string[] }) {
  const make = useCallback(() => ({ name }) as unknown as Build, [name]);
  const build = useBuild(make, turn);
  if (build && !built.includes(name)) built.push(name);
  return null;
}

/** Lets `ms` milliseconds pass, with what the timers they fire render. */
const pass = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

describe('섬을 짓는 차례', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('마을은 한 섬씩 차례로 짓고, 캔버스는 남은 섬을 센다', async () => {
    const works: Works = { pending: 0, warm: false };
    const built: string[] = [];
    const page = await mount(
      <WorksContext.Provider value={works}>
        <Island name="가운데" turn={0} built={built} />
        <Island name="동쪽" turn={1} built={built} />
        <Island name="깃발" turn={9} built={built} />
      </WorksContext.Provider>,
    );
    expect(works.pending).toBe(3);
    await pass(0);
    expect(built).toEqual(['가운데']);
    await pass(60);
    expect(built).toEqual(['가운데', '동쪽']);
    expect(works.pending).toBe(1);
    await pass(479);
    expect(built).toHaveLength(2);
    await pass(1);
    expect(built).toEqual(['가운데', '동쪽', '깃발']);
    expect(works.pending).toBe(0);
    await page.unmount();
  });

  it('이미 그리고 있는 캔버스에 뒤늦게 서는 섬은 차례를 기다리지 않는다', async () => {
    const works: Works = { pending: 0, warm: true };
    const built: string[] = [];
    const page = await mount(
      <WorksContext.Provider value={works}>
        <Island name="깃발" turn={9} built={built} />
      </WorksContext.Provider>,
    );
    expect(built).toEqual([]);
    await pass(0);
    expect(built).toEqual(['깃발']);
    expect(works.pending).toBe(0);
    await page.unmount();
  });

  it('지어지기 전에 사라진 섬은 세지 않는다', async () => {
    const works: Works = { pending: 0, warm: false };
    const page = await mount(
      <WorksContext.Provider value={works}>
        <Island name="깃발" turn={9} built={[]} />
      </WorksContext.Provider>,
    );
    expect(works.pending).toBe(1);
    await page.unmount();
    expect(works.pending).toBe(0);
  });
});
