import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createVillage } from '../../minihome/village';
import { mount, type } from '../../__tests__/mount';
import { draw, type DrawResult, type DrawView } from '../draw';
import type { GameProps } from '../game';
import type { GameSession } from '../protocol';
import { gameOf } from '../registry';

const NOW = 5_000_000;
const me = { id: 'me', name: '나', peer: 'peer-me' };
const friend = { id: 'friend', name: '친구', peer: 'peer-friend' };
const third = { id: 'third', name: '셋째', peer: null };

const view = (changes: Partial<DrawView> = {}): DrawView => ({
  phase: 'drawing',
  turn: 1,
  turns: 3,
  drawer: me.id,
  role: 'drawer',
  word: '사과',
  letters: 2,
  scores: [
    { id: me.id, name: '나', score: 5 },
    { id: friend.id, name: '친구', score: 19 },
    { id: third.id, name: '셋째', score: 0 },
  ],
  guessed: [],
  endsAt: NOW + 80_000,
  ...changes,
});

/** What the canvas was asked to do, call by call. */
let painted: string[] = [];
const fakeContext = new Proxy({} as Record<string, unknown>, {
  get: (target, name: string) => (name in target ? target[name] : (...args: unknown[]) => painted.push(`${name}(${args.join(',')})`)),
  set: (target, name: string, value) => {
    target[name] = value;
    return true;
  },
});

const mounted: { unmount: () => Promise<void> }[] = [];

async function panel(start: DrawView, you = me.id) {
  const listeners = new Set<(event: unknown) => void>();
  const sent = vi.fn((_action: unknown) => true);
  const players = [me, friend, third];
  const session = (game: DrawView): GameSession<DrawView> => ({
    kind: 'draw', phase: 'playing', host: me.id, players, you, game, result: null, seq: 1, now: NOW,
  });
  // As the dock gives them: the same functions for the whole game.
  const onEvent = (listener: (event: unknown) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const serverNow = () => NOW;
  const teleport = () => false;
  const props = (game: DrawView): GameProps<DrawView> => ({
    session: session(game),
    view: game,
    me: players.find((player) => player.id === you) ?? null,
    act: sent,
    onEvent,
    serverNow,
    teleport,
  });
  const Panel = draw.Panel;
  const rendered = await mount(<Panel {...props(start)} />);
  mounted.push(rendered);
  const emit = (event: unknown) =>
    act(() => {
      for (const listener of [...listeners]) listener(event);
    });
  const canvas = () => rendered.container.querySelector('canvas')!;
  const pointer = (name: string, x: number, y: number) =>
    act(() => {
      canvas().dispatchEvent(new PointerEvent(name, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, pointerType: 'mouse', button: 0 }));
    });
  const wait = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const button = (name: string) =>
    [...rendered.container.querySelectorAll('button')].find((item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name);
  const text = (selector: string) => rendered.container.querySelector(selector)?.textContent;
  return { ...rendered, sent, emit, canvas, pointer, wait, button, text, rerender: (game: DrawView) => rendered.rerender(<Panel {...props(game)} />) };
}

describe('캐치마인드 패널', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    painted = [];
    // A board 400 by 300 pixels on screen and on the canvas.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeContext as unknown as RenderingContext);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400, height: 300 } as DOMRect);
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400);
    vi.stubGlobal('requestAnimationFrame', (paint: FrameRequestCallback) => {
      paint(0);
      return 1;
    });
  });

  afterEach(async () => {
    for (const view of mounted.splice(0)) await view.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('그리는 사람은 제시어와 도구를 보고, 앞서 그린 것을 받은 뒤 그린 선이 조각으로 나간다', async () => {
    const drawer = await panel(view());
    expect(drawer.text('.mg-draw-word')).toBe('제시어사과');
    expect(drawer.text('.mg-draw-turn')).toBe('차례 1/3');
    expect(drawer.text('[role="timer"]')).toBe('1:20');
    // On opening it asks for what was drawn before, and draws nothing until that has come.
    expect(drawer.sent).toHaveBeenCalledWith({ replay: true });
    const colors = [...drawer.container.querySelectorAll('[aria-label="색"] [role="radio"]')];
    expect(colors.map((swatch) => swatch.getAttribute('aria-label'))).toEqual(['검정', '빨강', '주황', '노랑', '초록', '파랑', '보라', '갈색']);
    expect(colors[0]!.getAttribute('aria-checked')).toBe('true');
    const sizes = [...drawer.container.querySelectorAll('[aria-label="굵기"] [role="radio"]')];
    expect(sizes.map((size) => [size.getAttribute('aria-label'), size.getAttribute('aria-checked')])).toEqual([
      ['가늘게', 'false'],
      ['보통', 'true'],
      ['굵게', 'false'],
    ]);
    expect(drawer.button('되돌리기')!.disabled).toBe(true);
    expect(drawer.button('지우기')!.disabled).toBe(true);
    await drawer.pointer('pointerdown', 40, 30);
    await drawer.wait(60);
    expect(drawer.sent).toHaveBeenCalledTimes(1);

    const before = { points: [[0.5, 0.5], [0.6, 0.5]], color: '#e5484d', size: 3, join: false };
    await drawer.emit({ type: 'replay', turn: 1, part: 0, parts: 1, strokes: [before] });
    expect(painted).toContain('moveTo(200,150)');
    expect(drawer.button('되돌리기')!.disabled).toBe(false);

    // Down at (40, 30) of 400 by 300; each move goes halfway toward the pointer; up where it was let go.
    painted = [];
    await drawer.pointer('pointerdown', 40, 30);
    expect(painted).toContain(`arc(40,30,2.8000000000000003,0,${Math.PI * 2})`);
    await drawer.wait(50);
    expect(drawer.sent).toHaveBeenLastCalledWith({ stroke: { points: [[0.1, 0.1]], color: '#222222', size: 2 } });
    await drawer.pointer('pointermove', 200, 150);
    await drawer.pointer('pointerup', 200, 150);
    await drawer.wait(50);
    expect(drawer.sent).toHaveBeenLastCalledWith({ stroke: { points: [[0.3, 0.3], [0.5, 0.5]], color: '#222222', size: 2, join: true } });

    // Arrow keys choose the colour and size; 되돌리기 and 지우기 go out after the strokes before them.
    await act(() => {
      colors[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(colors[1]!.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(colors[1]);
    await act(() => (sizes[2] as HTMLButtonElement).click());
    await drawer.pointer('pointerdown', 200, 30);
    await drawer.pointer('pointerup', 200, 30);
    await act(() => drawer.button('되돌리기')!.click());
    await act(() => drawer.button('지우기')!.click());
    await drawer.wait(50);
    expect(drawer.sent).toHaveBeenLastCalledWith({ stroke: { points: [[0.5, 0.1]], color: '#e5484d', size: 3 } });
    await drawer.wait(50);
    expect(drawer.sent).toHaveBeenLastCalledWith({ undo: true });
    await drawer.wait(50);
    expect(drawer.sent).toHaveBeenLastCalledWith({ clear: true });
    expect(drawer.button('지우기')!.disabled).toBe(true);
    const count = drawer.sent.mock.calls.length;
    await drawer.wait(500);
    expect(drawer.sent).toHaveBeenCalledTimes(count);

    // The turn ends: the word is everyone's, the tools go, and the canvas takes no more lines.
    await drawer.rerender(view({ phase: 'reveal', endsAt: NOW + 4_000 }));
    expect(drawer.text('.mg-draw-word')).toBe('정답사과');
    expect(drawer.container.querySelector('[aria-label="색"]')).toBeNull();
    await drawer.pointer('pointerdown', 40, 30);
    await drawer.wait(100);
    expect(drawer.sent).toHaveBeenCalledTimes(count);
  });

  it('맞히는 사람은 글자 수만 보고, 받은 선을 그리며, 답을 보내고 채팅을 본다', async () => {
    const guesser = await panel(view({ role: 'guesser', word: null, drawer: friend.id }), me.id);
    expect(guesser.text('.mg-draw-word')).toBe('2글자');
    expect(guesser.container.querySelector('[aria-label="색"]')).toBeNull();
    expect(guesser.sent).toHaveBeenCalledWith({ replay: true });
    const strokes = () => painted.filter((call) => call === 'stroke()').length;
    // The drawing so far, in two parts (the second carrying on the first's line), then what is drawn after it.
    await guesser.emit({ type: 'replay', turn: 1, part: 0, parts: 2, strokes: [{ points: [[0, 0], [0.5, 0.5]], color: '#222222', size: 1, join: false }] });
    painted = [];
    await guesser.emit({ type: 'replay', turn: 1, part: 1, parts: 2, strokes: [{ points: [[1, 0]], color: '#222222', size: 1, join: true }] });
    expect(painted).toEqual(expect.arrayContaining(['moveTo(0,0)', 'quadraticCurveTo(200,150,300,75)', 'lineTo(400,0)']));
    expect(strokes()).toBe(1);
    painted = [];
    await guesser.emit({ type: 'stroke', turn: 1, stroke: { points: [[0.2, 0.2]], color: '#3b82f6', size: 3, join: false } });
    expect(painted).toContain('arc(80,60,6,0,6.283185307179586)');
    painted = [];
    await guesser.emit({ type: 'undo', turn: 1 });
    expect(painted.some((call) => call.startsWith('arc('))).toBe(false);
    expect(strokes()).toBe(1);
    painted = [];
    await guesser.emit({ type: 'stroke', turn: 1, stroke: { points: [[0.9, 0.9], [0.8, 0.8]], color: '#3b82f6', size: 3, join: false } });
    expect(strokes()).toBe(2);
    // Strokes of an old turn are not this board's.
    painted = [];
    await guesser.emit({ type: 'stroke', turn: 0, stroke: { points: [[0.2, 0.2]], color: '#3b82f6', size: 3, join: false } });
    expect(painted).toEqual([]);
    // A replay nobody here asked for again is not drawn over the board.
    await guesser.emit({ type: 'replay', turn: 1, part: 0, parts: 1, strokes: [] });
    expect(painted).toEqual([]);

    const field = guesser.container.querySelector<HTMLInputElement>('input[aria-label="정답"]')!;
    expect(guesser.button('보내기')!.disabled).toBe(true);
    await type(field, '  사 과 ');
    await act(() => guesser.button('보내기')!.click());
    expect(guesser.sent).toHaveBeenLastCalledWith({ guess: '사 과' });
    expect(field.value).toBe('');

    await guesser.emit({ type: 'chat', player: third.id, text: '고양이' });
    await guesser.emit({ type: 'guessed', player: friend.id, points: 19 });
    await guesser.emit({ type: 'reveal', turn: 1, drawer: friend.id, word: '사과' });
    const lines = [...guesser.container.querySelectorAll('[role="log"] li')].map((line) => line.textContent);
    expect(lines).toEqual(['셋째고양이', '친구맞혔어요', '정답 사과']);

    // Once right, the field takes no more; the scores mark who draws and who has it.
    await guesser.rerender(view({ role: 'guesser', word: null, drawer: friend.id, guessed: [me.id] }));
    expect(field.readOnly).toBe(true);
    expect(field.placeholder).toBe('맞혔어요');
    await type(field, '또');
    expect(guesser.button('보내기')!.disabled).toBe(true);
    const rows = [...guesser.container.querySelectorAll('[aria-label="점수"] li')];
    expect(rows.map((row) => row.textContent)).toEqual(['친구그리는 사람19', '나맞혔어요5', '셋째0']);
    expect(rows[1]!.getAttribute('aria-current')).toBe('true');

    // The next turn starts on a blank board.
    painted = [];
    await guesser.rerender(view({ turn: 2, role: 'drawer', drawer: me.id, word: '기린' }));
    expect(painted).toContain('clearRect(0,0,400,300)');
    expect(painted).not.toContain('stroke()');
    expect(guesser.container.querySelector('input[aria-label="정답"]')).toBeNull();
    expect(guesser.button('되돌리기')!.disabled).toBe(true);
  });

  it('구경하는 사람은 그림과 채팅과 점수만 본다', async () => {
    const watcher = await panel(view({ role: 'watcher', word: null }), 'someone');
    expect(watcher.sent).toHaveBeenCalledWith({ replay: true });
    expect(watcher.container.querySelector('input')).toBeNull();
    expect(watcher.container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(watcher.text('.mg-draw-word')).toBe('2글자');
    expect(watcher.canvas().getAttribute('aria-label')).toBe('그림판');
    expect(watcher.canvas().hasAttribute('data-editable')).toBe(false);
  });

  it('끝나면 순위를 보여 주고, 같은 점수는 같은 순위다', async () => {
    const result: DrawResult = {
      ranking: [
        { id: friend.id, name: '친구', score: 30, rank: 1 },
        { id: me.id, name: '나', score: 30, rank: 1 },
        { id: third.id, name: '셋째', score: 12, rank: 3 },
      ],
    };
    const Result = draw.Result;
    const session: GameSession<DrawView> = {
      kind: 'draw', phase: 'ended', host: me.id, players: [me, friend, third], you: me.id, game: view(), result, seq: 9, now: NOW,
    };
    const rendered = await mount(
      <Result session={session} view={view()} me={me} act={() => true} onEvent={() => () => {}} serverNow={() => NOW} teleport={() => false} result={result} />,
    );
    mounted.push(rendered);
    const rows = [...rendered.container.querySelectorAll('li')];
    expect(rows.map((row) => row.textContent)).toEqual(['1위친구30점', '1위나30점', '3위셋째12점']);
    expect(rows[1]!.getAttribute('aria-current')).toBe('true');
  });

  it('등록되어 있고, 섬에서 필요한 것이 없다', () => {
    expect(gameOf('draw')).toBe(draw);
    expect([draw.label, draw.minPlayers, draw.maxPlayers]).toEqual(['캐치마인드', 2, 12]);
    const session = { kind: 'draw' } as GameSession;
    expect(draw.layout({ building: createVillage(), spots: () => [], position: null, session })).toEqual({});
  });
});
