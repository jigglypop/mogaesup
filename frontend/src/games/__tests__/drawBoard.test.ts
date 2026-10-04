import { describe, expect, it, vi } from 'vitest';

import { Board, MAX_PIECE, MAX_POINTS, MAX_STROKES, onGrid, paint, Pen, readEvent, type Outgoing, type Point } from '../draw/board';

/** Everything the pen has to send, in order. */
function drain(pen: Pen): Outgoing[] {
  const sent: Outgoing[] = [];
  for (let message = pen.next(); message; message = pen.next()) sent.push(message);
  return sent;
}

const pointsOf = (message: Outgoing | undefined): Point[] => (message && 'stroke' in message ? message.stroke.points : []);

describe('캐치마인드 그림판', () => {
  it('조각은 새 선을 긋거나 마지막 선을 잇고, 되돌리기는 선 하나를 통째로 지운다', () => {
    const board = new Board(1);
    const changed = vi.fn();
    board.subscribe(changed);
    board.add({ points: [[0.1, 0.1]], color: '#222222', size: 1, join: false });
    board.add({ points: [[0.2, 0.2], [0.3, 0.3]], color: '#222222', size: 1, join: true });
    board.add({ points: [[0.5, 0.5]], color: '#e5484d', size: 3, join: false });
    expect(board.strokes).toHaveLength(2);
    expect(board.strokes[0]!.points).toEqual([[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]]);
    expect(board.points).toBe(4);
    expect(board.undo()).toBe(true);
    expect(board.points).toBe(3);
    board.clear();
    expect(board.undo()).toBe(false);
    // A piece that would carry on a blank board starts a stroke of its own.
    board.add({ points: [[0.4, 0.4]], color: '#222222', size: 2, join: true });
    expect(board.strokes).toHaveLength(1);
    board.reset(2);
    expect([board.turn, board.strokes.length, board.points]).toEqual([2, 0, 0]);
    expect(changed).toHaveBeenCalledTimes(7);
  });

  it('펜은 선을 바로 그리고 매끄럽게 하며, 끝은 손을 뗀 곳에 둔다', () => {
    const board = new Board(1);
    const pen = new Pen(board);
    expect(pen.start([0.1, 0.1], '#3b82f6', 2)).toBe(true);
    expect(pen.drawing).toBe(true);
    // Each move goes halfway toward the pointer; one too near adds nothing.
    pen.move([0.5, 0.1]);
    pen.move([0.301, 0.1]);
    pen.end([0.5, 0.1]);
    expect(pen.drawing).toBe(false);
    expect(board.strokes[0]!.points).toEqual([[0.1, 0.1], [0.3, 0.1], [0.5, 0.1]]);
    expect(drain(pen)).toEqual([{ stroke: { points: [[0.1, 0.1], [0.3, 0.1], [0.5, 0.1]], color: '#3b82f6', size: 2 } }]);
    // Moves after the line has ended draw nothing.
    pen.move([0.9, 0.9]);
    expect(board.points).toBe(3);
    expect(pen.next()).toBeUndefined();
  });

  it('긴 선은 64점까지의 조각으로 나눠 이어 보내고, 되돌리기·지우기는 그 뒤 제자리에 간다', () => {
    const board = new Board(1);
    const pen = new Pen(board);
    pen.start([0, 0.5], '#222222', 1);
    // The first piece goes out at once; what is drawn after it carries the line on.
    expect(pen.next()).toEqual({ stroke: { points: [[0, 0.5]], color: '#222222', size: 1 } });
    for (let index = 1; index <= 140; index += 1) pen.move([index / 140, 0.5]);
    const pieces = drain(pen);
    expect(pieces.map((piece) => pointsOf(piece).length)).toEqual([MAX_PIECE, MAX_PIECE, 140 - 2 * MAX_PIECE]);
    expect(pieces.every((piece) => 'stroke' in piece && piece.stroke.join === true && piece.stroke.color === '#222222')).toBe(true);
    expect(board.strokes).toHaveLength(1);
    expect(board.strokes[0]!.points).toEqual([[0, 0.5], ...pieces.flatMap(pointsOf)]);
    expect(board.strokes[0]!.points.every(([x]) => x === onGrid(x))).toBe(true);

    // Undo ends the line under way and follows its last piece; with nothing left, there is nothing to send.
    pen.start([0.2, 0.2], '#e5484d', 3);
    pen.move([0.6, 0.6]);
    expect(pen.undo()).toBe(true);
    expect(pen.drawing).toBe(false);
    expect(drain(pen)).toEqual([
      { stroke: { points: [[0.2, 0.2], [0.4, 0.4]], color: '#e5484d', size: 3 } },
      { undo: true },
    ]);
    expect(board.strokes).toHaveLength(1);
    pen.clear();
    expect(pen.undo()).toBe(false);
    expect(drain(pen)).toEqual([{ clear: true }]);
    pen.start([0.5, 0.5], '#222222', 1);
    pen.drop();
    expect(pen.next()).toBeUndefined();
    expect(pen.drawing).toBe(false);
  });

  it('보드가 담을 수 있는 만큼만 그린다', () => {
    const board = new Board(1);
    const pen = new Pen(board);
    for (let index = 0; index < MAX_STROKES; index += 1) board.add({ points: [[0.5, 0.5]], color: '#222222', size: 1, join: false });
    expect(board.full).toBe(true);
    expect(pen.start([0.1, 0.1], '#222222', 1)).toBe(false);
    expect(pen.next()).toBeUndefined();

    const crowded = new Board(1);
    const tight = new Pen(crowded);
    crowded.add({ points: Array.from({ length: MAX_POINTS - 2 }, (): Point => [0.5, 0.5]), color: '#222222', size: 1, join: false });
    expect(tight.start([0.1, 0.1], '#222222', 1)).toBe(true);
    tight.move([0.9, 0.1]);
    expect(crowded.points).toBe(MAX_POINTS);
    expect(crowded.full).toBe(true);
    tight.move([0.9, 0.9]);
    expect(crowded.points).toBe(MAX_POINTS);
    expect(tight.drawing).toBe(false);
  });

  it('서버 이벤트는 모양을 확인하고 읽는다', () => {
    const piece = { points: [[0.1, 0.2]], color: '#222222', size: 2, join: true };
    expect(readEvent({ type: 'stroke', turn: 1, stroke: piece })).toEqual({ type: 'stroke', turn: 1, stroke: piece });
    expect(readEvent({ type: 'stroke', turn: 1, stroke: { ...piece, join: undefined } })).toEqual({
      type: 'stroke',
      turn: 1,
      stroke: { ...piece, join: false },
    });
    expect(readEvent({ type: 'undo', turn: 2 })).toEqual({ type: 'undo', turn: 2 });
    expect(readEvent({ type: 'clear', turn: 2 })).toEqual({ type: 'clear', turn: 2 });
    expect(readEvent({ type: 'replay', turn: 1, part: 0, parts: 2, strokes: [piece] })).toEqual({
      type: 'replay',
      turn: 1,
      part: 0,
      parts: 2,
      strokes: [piece],
    });
    expect(readEvent({ type: 'chat', player: 'p', text: '고양이' })).toEqual({ type: 'chat', player: 'p', text: '고양이' });
    expect(readEvent({ type: 'guessed', player: 'p', points: 19 })).toEqual({ type: 'guessed', player: 'p', points: 19 });
    expect(readEvent({ type: 'reveal', turn: 1, drawer: 'p', word: '사과' })).toEqual({ type: 'reveal', turn: 1, drawer: 'p', word: '사과' });
    for (const bad of [
      null,
      'stroke',
      { type: 'stroke', turn: 1 },
      { type: 'stroke', turn: '1', stroke: piece },
      { type: 'stroke', turn: 1, stroke: { ...piece, points: [[0.1]] } },
      { type: 'stroke', turn: 1, stroke: { ...piece, points: [['0.1', 0.2]] } },
      { type: 'stroke', turn: 1, stroke: { ...piece, size: 1.5 } },
      { type: 'replay', turn: 1, part: 0, parts: 1, strokes: [{}] },
      { type: 'replay', turn: 1, part: 0, strokes: [] },
      { type: 'chat', player: 'p' },
      { type: 'guessed', player: 'p', points: -1 },
      { type: 'reveal', turn: 1, drawer: 'p' },
      { type: 'dance', turn: 1 },
    ]) {
      expect(readEvent(bad)).toBeNull();
    }
  });

  it('점은 서버의 격자에 맞추고, 그리기는 너비에 맞춰 점의 가운데를 지나는 곡선으로 한다', () => {
    expect([onGrid(0.123_46), onGrid(-0.2), onGrid(1.7), onGrid(0.000_04)]).toEqual([0.1235, 0, 1, 0]);
    const calls: string[] = [];
    const context = new Proxy({} as Record<string, unknown>, {
      get: (target, name: string) => (name in target ? target[name] : (...args: unknown[]) => calls.push(`${name}(${args.join(',')})`)),
      set: (target, name: string, value) => {
        target[name] = value;
        calls.push(`${name}=${value}`);
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    paint(
      context,
      [
        { points: [[0.5, 0.5]], color: '#e5484d', size: 2 },
        { points: [[0, 0], [0.5, 0.5], [1, 0.5]], color: '#222222', size: 3 },
      ],
      400,
      300,
    );
    expect(calls).toEqual([
      'clearRect(0,0,400,300)',
      'lineCap=round',
      'lineJoin=round',
      'strokeStyle=#e5484d',
      'fillStyle=#e5484d',
      'lineWidth=5.6000000000000005',
      'beginPath()',
      `arc(200,150,2.8000000000000003,0,${Math.PI * 2})`,
      'fill()',
      'strokeStyle=#222222',
      'fillStyle=#222222',
      'lineWidth=12',
      'beginPath()',
      'moveTo(0,0)',
      'quadraticCurveTo(200,150,300,150)',
      'lineTo(400,150)',
      'stroke()',
    ]);
  });
});
