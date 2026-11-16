import { act, useCallback, type ReactElement, type ReactNode, type RefObject } from 'react';

import { OrthographicCamera, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import type { Build } from '../scene/build';
import { AZIMUTH, dragShift, ELEVATION, frameOf, stand, TILT_RANGE, ZOOM_RANGE } from '../scene/frames';
import type { Gaze } from '../scene/look';
import { WATER_LEVEL } from '../scene/mood';
import { ISLANDS } from '../scene/terrain';
import { newWorks, useBuild, WorksContext, type Works } from '../scene/works';
import { PLOT_REACH } from '../village';

type Created = (state: { gl: object; camera: OrthographicCamera }) => void;
const { canvas } = vi.hoisted(() => ({ canvas: { children: null as ReactNode, created: null as Created | null } }));
// The canvas needs a graphics card. What is looked at here is what the box around it hears of the pointer, the wheel
// and the fingers, and what it tells the scene: how far the camera is turned, tilted, moved and zoomed.
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, onCreated }: { children: ReactNode; onCreated?: Created }) => {
    canvas.children = children;
    canvas.created = onCreated ?? null;
    return <canvas />;
  },
  useFrame: () => undefined,
  useThree: () => undefined,
}));

const { Stage } = await import('../scene/Stage');

type Told = { gaze: RefObject<Gaze> };
/** What the stage has told its scene. */
const told = () => (canvas.children as ReactElement<Told>[])[0]!.props;
const gaze = () => told().gaze.current;

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
    expect(gaze().turn).toBeCloseTo(-40 * 0.0026, 10);
    expect(box.dataset['turning']).toBe('');
    await point('pointerup', { pointerId: 1, pointerType: 'mouse', clientX: 340 });
    expect(box.dataset['turning']).toBeUndefined();
  });

  it('옆으로 끌면 끝없이 돌아간다', async () => {
    await point('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 100 });
    for (let x = 400; x <= 4000; x += 300) await point('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: x });
    expect(gaze().turn).toBeCloseTo(-3900 * 0.0026, 10);
    expect(Math.abs(gaze().turn)).toBeGreaterThan(Math.PI * 2);
  });

  it('위아래로 끌면 기울고, 20도에서 70도 사이에서 멈춘다', async () => {
    await point('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 300, clientY: 300 });
    await point('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 300, clientY: 340 });
    // 아래로 끌면 위에서 내려다보는 쪽으로 선다.
    expect(gaze().tilt).toBeCloseTo(ELEVATION + 40 * 0.0026, 10);
    expect(gaze().turn).toBe(0);
    await point('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 300, clientY: 1300 });
    expect(gaze().tilt).toBe(TILT_RANGE.max);
    await point('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 300, clientY: -1300 });
    expect(gaze().tilt).toBe(TILT_RANGE.min);
  });

  it('6픽셀이 안 되게 움직인 누름은 끌기가 아니다', async () => {
    await point('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 300, clientY: 300 });
    await point('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 304, clientY: 303 });
    expect(box.dataset['turning']).toBeUndefined();
    await point('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 305, clientY: 305 });
    expect(box.dataset['turning']).toBe('');
  });

  it('둘째 손가락이 닿으면 끌기가 끝난다: 잡은 표시도 남지 않는다', async () => {
    await point('pointerdown', { pointerId: 1, pointerType: 'touch', buttons: 1, clientX: 300, clientY: 400 });
    await point('pointermove', { pointerId: 1, pointerType: 'touch', buttons: 1, clientX: 320, clientY: 400 });
    expect(box.dataset['turning']).toBe('');
    await point('pointerdown', { pointerId: 2, pointerType: 'touch', buttons: 1, clientX: 420, clientY: 400 });
    expect(box.dataset['turning']).toBeUndefined();
    // 두 손가락이 벌어진 만큼 당겨지고, 카메라는 더 돌지도 기울지도 않는다.
    const turned = gaze().turn;
    await point('pointermove', { pointerId: 2, pointerType: 'touch', buttons: 1, clientX: 520, clientY: 400 });
    expect(gaze().zoom).toBeCloseTo(2, 10);
    expect(gaze().turn).toBe(turned);
    expect(gaze().tilt).toBe(ELEVATION);
    await point('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 520, clientY: 400 });
    await point('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 320, clientY: 400 });
    expect(box.dataset['turning']).toBeUndefined();
  });

  it.each(['mouse', 'pen'])('%s: 다른 데서 뗀 뒤 누르지 않고 지나가기만 해서는 카메라가 돌지 않는다', async (pointerType) => {
    // 그림에서 누르고, 뗀 것은 이 상자가 듣지 못했다.
    await point('pointerdown', { pointerId: 5, pointerType, button: 0, buttons: 1, clientX: 300 });
    await point('pointermove', { pointerId: 5, pointerType, buttons: 0, clientX: 380 });
    await point('pointermove', { pointerId: 5, pointerType, buttons: 0, clientX: 460 });
    expect(gaze().turn).toBe(0);
    expect(box.dataset['turning']).toBeUndefined();
    // 다시 눌러 끌면 돈다.
    await point('pointerdown', { pointerId: 5, pointerType, button: 0, buttons: 1, clientX: 300 });
    await point('pointermove', { pointerId: 5, pointerType, buttons: 1, clientX: 320 });
    expect(gaze().turn).toBeCloseTo(-20 * 0.0026, 10);
  });

  it('휠은 페이지 대신 그림을 당기고, ctrl을 누른 한 칸도 한 칸만큼만 당긴다', () => {
    expect(wheel(-100).defaultPrevented).toBe(true);
    expect(gaze().zoom).toBeCloseTo(Math.exp(0.16), 10);
    wheel(100);
    expect(gaze().zoom).toBeCloseTo(1, 10);
    // 트랙패드의 핀치: ctrl과 함께 오는 잔걸음.
    wheel(-4, { ctrlKey: true });
    expect(gaze().zoom).toBeCloseTo(Math.exp(0.048), 10);
    wheel(4, { ctrlKey: true });
    // ctrl을 누르고 돌린 마우스 휠.
    wheel(-100, { ctrlKey: true });
    expect(gaze().zoom).toBeCloseTo(Math.exp(0.16), 10);
    // 줄 단위로 오는 휠.
    wheel(3, { deltaMode: WheelEvent.DOM_DELTA_LINE });
    expect(gaze().zoom).toBeCloseTo(Math.exp(0.16 - 48 * 0.0016), 10);
    // 끝에서 멈춘다.
    for (let notch = 0; notch < 20; notch++) wheel(100);
    expect(gaze().zoom).toBe(ZOOM_RANGE.min);
  });

  it('사파리가 따로 알리는 트랙패드 핀치로도 그림을 당긴다', () => {
    expect(gesture('gesturestart', 1).defaultPrevented).toBe(true);
    expect(gesture('gesturechange', 1.1).defaultPrevented).toBe(true);
    expect(gaze().zoom).toBeCloseTo(1.1, 10);
    gesture('gesturechange', 1.5);
    expect(gaze().zoom).toBeCloseTo(1.5, 10);
    // 새 핀치는 다시 1에서 센다.
    gesture('gesturestart', 1);
    gesture('gesturechange', 0.8);
    expect(gaze().zoom).toBeCloseTo(1.2, 10);
  });

  it('화면에 닿은 두 손가락은 포인터로 듣는다: 같은 핀치를 두 번 세지 않는다', async () => {
    await point('pointerdown', { pointerId: 1, pointerType: 'touch', buttons: 1, clientX: 300, clientY: 400 });
    await point('pointerdown', { pointerId: 2, pointerType: 'touch', buttons: 1, clientX: 400, clientY: 400 });
    gesture('gesturestart', 1);
    await point('pointermove', { pointerId: 2, pointerType: 'touch', buttons: 1, clientX: 450, clientY: 400 });
    expect(gesture('gesturechange', 1.5).defaultPrevented).toBe(true);
    expect(gaze().zoom).toBeCloseTo(1.5, 10);
  });
});

describe('카메라를 옮기는 손짓', () => {
  let page: Awaited<ReturnType<typeof mount>>;
  let box: HTMLElement;
  const R = PLOT_REACH;
  const homes = [{ id: 'sol', x: 0, z: 0, profile: null }, { id: 'east', x: R, z: 0, profile: null }, { id: 'south', x: 0, z: R, profile: null }];
  const frame = frameOf(homes);
  /** The camera as the look stands it over a canvas 1440 by 900, 20 pixels a metre. */
  const camera = new OrthographicCamera(-720, 720, 450, -450, 1, 400);
  camera.zoom = 20;
  camera.updateProjectionMatrix();
  stand(camera, frame.target, AZIMUTH, 120);
  const point = (type: string, init: PointerEventInit) => act(async () => void box.querySelector('canvas')!.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init })));
  /** Where a spot on the water falls on the canvas, in pixels from its top left. */
  const pixel = (x: number, z: number) => {
    const at = new Vector3(x, WATER_LEVEL, z).project(camera);
    return { clientX: (at.x * 0.5 + 0.5) * 1440, clientY: (-at.y * 0.5 + 0.5) * 900 };
  };
  const tap = async (at: { clientX: number; clientY: number }) => {
    await point('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, ...at });
    await point('pointerup', { pointerId: 1, pointerType: 'mouse', button: 0, ...at });
  };

  beforeEach(async () => {
    HTMLElement.prototype.setPointerCapture = () => undefined;
    page = await mount(<Stage homes={homes} bridges={[]} frame={frame} focus={null} />);
    box = page.container.querySelector<HTMLElement>('.mg-saju-canvas')!;
    box.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => canvas.created?.({ gl: {}, camera }));
  });
  afterEach(() => page.unmount());

  it.each([
    ['오른쪽 버튼으로', { button: 2, buttons: 2 }],
    ['shift를 누르고', { button: 0, buttons: 1, shiftKey: true }],
  ])('%s 끌면 손 밑의 땅이 손을 따라 옮겨 가고, 카메라는 돌지 않는다', async (_, held) => {
    await point('pointerdown', { pointerId: 1, pointerType: 'mouse', clientX: 700, clientY: 450, ...held });
    await point('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 760, clientY: 420, ...held });
    const shift = dragShift(60, -30, 20, AZIMUTH, ELEVATION);
    expect(gaze().pan.x).toBeCloseTo(shift.x, 9);
    expect(gaze().pan.z).toBeCloseTo(shift.z, 9);
    expect(gaze().turn).toBe(0);
    expect(gaze().tilt).toBe(ELEVATION);
    expect(box.dataset['turning']).toBe('');
  });

  it('마을의 섬들 밖으로는 옮겨 가지 않는다', async () => {
    await point('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 2, buttons: 2, clientX: 700, clientY: 450 });
    await point('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 2, clientX: -9000, clientY: -9000 });
    const [x, , z] = frame.target;
    expect(x + gaze().pan.x).toBeLessThanOrEqual(R + ISLANDS.neighbour.half + 1e-9);
    expect(x + gaze().pan.x).toBeGreaterThanOrEqual(-ISLANDS.home.half - 1e-9);
    expect(z + gaze().pan.z).toBeLessThanOrEqual(R + ISLANDS.neighbour.half + 1e-9);
    expect(z + gaze().pan.z).toBeGreaterThanOrEqual(-ISLANDS.home.half - 1e-9);
  });

  it('두 손가락을 함께 옮기면 보는 곳이 옮겨 가고, 카메라는 돌지 않는다', async () => {
    // 위아래로 벌린 두 손가락을 나란히 오른쪽으로 옮긴다: 벌린 거리는 거의 그대로다.
    await point('pointerdown', { pointerId: 1, pointerType: 'touch', buttons: 1, clientX: 720, clientY: 350 });
    await point('pointerdown', { pointerId: 2, pointerType: 'touch', buttons: 1, clientX: 720, clientY: 550 });
    await point('pointermove', { pointerId: 1, pointerType: 'touch', buttons: 1, clientX: 770, clientY: 350 });
    await point('pointermove', { pointerId: 2, pointerType: 'touch', buttons: 1, clientX: 770, clientY: 550 });
    // 두 손가락의 가운데가 50픽셀 옮겨 갔다.
    const shift = dragShift(50, 0, 20, AZIMUTH, ELEVATION);
    expect(Math.abs(gaze().pan.x - shift.x)).toBeLessThan(0.1);
    expect(Math.abs(gaze().pan.z - shift.z)).toBeLessThan(0.1);
    expect(gaze().zoom).toBeCloseTo(1, 10);
    expect(gaze().turn).toBe(0);
    expect(gaze().tilt).toBe(ELEVATION);
  });

  it('휠은 포인터 쪽으로 당긴다', async () => {
    const at = pixel(R, 0);
    await act(async () => void box.querySelector('canvas')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, ...at })));
    const zoom = Math.exp(0.16);
    expect(gaze().zoom).toBeCloseTo(zoom, 10);
    // 포인터 밑의 동쪽 섬 쪽으로, 당긴 만큼 옮겨 갔다.
    const [x, , z] = frame.target;
    const toward = { x: R - x, z: -z };
    const length = Math.hypot(toward.x, toward.z);
    expect(gaze().pan.x / toward.x).toBeGreaterThan(0);
    expect(Math.hypot(gaze().pan.x, gaze().pan.z)).toBeGreaterThan(length * (1 - 1 / zoom) * 0.9);
  });

  it('물 위를 두 번 누르면 처음으로 돌아가고, 섬 위에서는 그대로다', async () => {
    await point('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 300, clientY: 300 });
    await point('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 2700, clientY: 340 });
    await point('pointerup', { pointerId: 1, pointerType: 'mouse', clientX: 2700, clientY: 340 });
    await act(async () => void box.querySelector('canvas')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -200, clientX: 700, clientY: 450 })));
    const moved = { ...gaze(), pan: { ...gaze().pan } };
    expect(moved.turn).toBeLessThan(-Math.PI * 2 + 0.5);
    // 섬 위: 그대로다.
    await tap(pixel(R, 0));
    await tap(pixel(R, 0));
    expect(gaze()).toEqual(moved);
    // 물 위: 처음으로 돌아간다. 돌린 바퀴는 가장 가까운 온 바퀴로 돌아간다.
    await tap({ clientX: 60, clientY: 60 });
    await tap({ clientX: 64, clientY: 62 });
    expect(gaze()).toEqual({ turn: -Math.PI * 2, tilt: ELEVATION, pan: { x: 0, z: 0 }, zoom: 1 });
  });

  it('끌고 난 뒤의 누름은 두 번 누름으로 세지 않는다', async () => {
    await act(async () => void box.querySelector('canvas')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -200, clientX: 720, clientY: 450 })));
    const zoom = gaze().zoom;
    await point('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 60, clientY: 60 });
    await point('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 90, clientY: 60 });
    await point('pointerup', { pointerId: 1, pointerType: 'mouse', clientX: 90, clientY: 60 });
    await tap({ clientX: 90, clientY: 60 });
    expect(gaze().zoom).toBe(zoom);
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

  it('마을은 한 섬씩 차례로, 섬마다 작업 하나에 짓고 사이를 비워 두지 않으며, 캔버스는 남은 섬을 센다', async () => {
    const works: Works = newWorks();
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
    await pass(1);
    expect(built).toEqual(['가운데', '동쪽']);
    expect(works.pending).toBe(1);
    await pass(7);
    expect(built).toHaveLength(2);
    await pass(1);
    expect(built).toEqual(['가운데', '동쪽', '깃발']);
    expect(works.pending).toBe(0);
    await page.unmount();
  });

  it('이미 그리고 있는 캔버스에 뒤늦게 서는 섬은 차례를 기다리지 않는다', async () => {
    const works: Works = { ...newWorks(), warm: true };
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
    const works: Works = newWorks();
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
