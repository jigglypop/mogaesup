/**
 * 캐치마인드's board: one turn's strokes, the drawer's pen that sends them, the events that carry them, and how they
 * are painted. Points run from 0 to 1 across and down a board of the same shape for everyone (server/src/games/draw.rs).
 */

/** The server's palette: a stroke's colour is part of the drawing, so it is the same for everyone in either theme. */
export const PALETTE = [
  { color: '#222222', name: '검정' },
  { color: '#e5484d', name: '빨강' },
  { color: '#f5a524', name: '주황' },
  { color: '#ffd60a', name: '노랑' },
  { color: '#30a46c', name: '초록' },
  { color: '#3b82f6', name: '파랑' },
  { color: '#8e4ec6', name: '보라' },
  { color: '#8b5a2b', name: '갈색' },
] as const;

/** Sizes 1 to 3, each a line width as a share of the board's width. */
export const SIZES = [
  { size: 1, name: '가늘게', width: 0.006 },
  { size: 2, name: '보통', width: 0.014 },
  { size: 3, name: '굵게', width: 0.03 },
] as const;

/** The board's width over its height. */
export const ASPECT = 4 / 3;
/** Points in one stroke message. */
export const MAX_PIECE = 64;
export const MAX_STROKES = 600;
export const MAX_POINTS = 20_000;
export const MAX_GUESS = 30;
/** How often the drawer's points go out: well under the socket's forty messages a second. */
export const SEND_EVERY_MS = 50;
/** A point closer than this (in board widths) to the last one adds nothing. */
const STEP = 0.003;
/** How far each new point moves toward where the pointer is: steadies a shaky hand. */
const SMOOTHING = 0.5;

export type Point = [number, number];
export type Stroke = { points: Point[]; color: string; size: number };
/** A stroke message or a part of one: `join` carries on the stroke before it. */
export type Piece = Stroke & { join: boolean };

export type DrawEvent =
  | { type: 'stroke'; turn: number; stroke: Piece }
  | { type: 'clear'; turn: number }
  | { type: 'undo'; turn: number }
  | { type: 'replay'; turn: number; part: number; parts: number; strokes: Piece[] }
  | { type: 'chat'; player: string; text: string }
  | { type: 'guessed'; player: string; points: number }
  | { type: 'reveal'; turn: number; drawer: string; word: string };

/** What the drawer sends, in order. */
export type Outgoing = { stroke: { points: Point[]; color: string; size: number; join?: true } } | { undo: true } | { clear: true };

/** A coordinate on the board kept to the server's grid, a ten-thousandth of it. */
export const onGrid = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;

/** One turn's drawing, stroke by stroke; whoever paints it hears when it changes. */
export class Board {
  turn: number;
  strokes: Stroke[] = [];
  /** Points in `strokes`. */
  points = 0;
  private readonly listeners = new Set<() => void>();

  constructor(turn = 0) {
    this.turn = turn;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    for (const listener of [...this.listeners]) listener();
  }

  /** A blank board for `turn`. */
  reset(turn: number) {
    this.turn = turn;
    this.strokes = [];
    this.points = 0;
    this.changed();
  }

  /** A new stroke, or more of the last one when the piece carries it on. */
  add(piece: Piece) {
    const last = this.strokes[this.strokes.length - 1];
    if (piece.join && last) last.points.push(...piece.points);
    else this.strokes.push({ points: [...piece.points], color: piece.color, size: piece.size });
    this.points += piece.points.length;
    this.changed();
  }

  undo(): boolean {
    const last = this.strokes.pop();
    if (!last) return false;
    this.points -= last.points.length;
    this.changed();
    return true;
  }

  clear() {
    this.strokes = [];
    this.points = 0;
    this.changed();
  }

  /** Whether the server would take no more: as many strokes or points as a board holds. */
  get full(): boolean {
    return this.strokes.length >= MAX_STROKES || this.points >= MAX_POINTS;
  }
}

/**
 * The drawer's pen: a line goes on the board as the pointer moves and out to the server in pieces of at most
 * [`MAX_PIECE`] points, the first starting a stroke and the rest carrying it on, with undo and clear in their place
 * between them. The page sends `next()` every [`SEND_EVERY_MS`].
 */
export class Pen {
  private queue: Outgoing[] = [];
  /** The line being drawn: where it got to, and its newest piece while that has not gone out. */
  private line: { color: string; size: number; at: Point; piece: { points: Point[] } | null } | null = null;

  constructor(private readonly board: Board) {}

  get drawing(): boolean {
    return this.line !== null;
  }

  /** Starts a line at `point`; false when the board is full. */
  start(point: Point, color: string, size: number): boolean {
    this.end();
    if (this.board.full) return false;
    const stroke = { points: [point], color, size };
    this.board.add({ ...stroke, join: false });
    this.queue.push({ stroke });
    this.line = { color, size, at: point, piece: stroke };
    return true;
  }

  /** Draws the line on toward `point`, steadied, unless it is too near to count or the board is full. */
  move([x, y]: Point) {
    const line = this.line;
    if (!line) return;
    const [lastX, lastY] = line.at;
    this.extend([onGrid(lastX + (x - lastX) * SMOOTHING), onGrid(lastY + (y - lastY) * SMOOTHING)]);
  }

  /** Ends the line, at `point` itself when given. */
  end(point?: Point) {
    if (point) this.extend(point);
    this.line = null;
  }

  private extend(point: Point) {
    const line = this.line;
    if (!line) return;
    const [x, y] = point;
    const [lastX, lastY] = line.at;
    if (Math.hypot(x - lastX, (y - lastY) / ASPECT) < STEP) return;
    if (this.board.points >= MAX_POINTS) return this.end();
    this.board.add({ points: [point], color: line.color, size: line.size, join: true });
    line.at = point;
    if (line.piece && line.piece.points.length < MAX_PIECE) {
      line.piece.points.push(point);
    } else {
      line.piece = { points: [point] };
      this.queue.push({ stroke: { points: line.piece.points, color: line.color, size: line.size, join: true } });
    }
  }

  /** Takes the last stroke away; false when there is none. */
  undo(): boolean {
    this.end();
    if (!this.board.undo()) return false;
    this.queue.push({ undo: true });
    return true;
  }

  clear() {
    this.end();
    this.board.clear();
    this.queue.push({ clear: true });
  }

  /** The next message to send, if any; a piece that goes out takes no more points. */
  next(): Outgoing | undefined {
    const message = this.queue.shift();
    if (message && 'stroke' in message && this.line?.piece?.points === message.stroke.points) this.line.piece = null;
    return message;
  }

  /** Forgets what has not gone out (the turn is over). */
  drop() {
    this.queue = [];
    this.line = null;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

function readPoint(value: unknown): Point | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [x, y] = value as unknown[];
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function readPiece(value: unknown): Piece | null {
  if (!isObject(value) || !Array.isArray(value['points']) || typeof value['color'] !== 'string' || !isCount(value['size'])) return null;
  const points = value['points'].map(readPoint);
  if (points.some((point) => point === null)) return null;
  return { points: points as Point[], color: value['color'], size: value['size'], join: value['join'] === true };
}

/** A 캐치마인드 event, or null when it is not one this page knows. */
export function readEvent(value: unknown): DrawEvent | null {
  if (!isObject(value)) return null;
  const { type, turn } = value;
  switch (type) {
    case 'stroke': {
      const stroke = readPiece(value['stroke']);
      return isCount(turn) && stroke ? { type, turn, stroke } : null;
    }
    case 'clear':
    case 'undo':
      return isCount(turn) ? { type, turn } : null;
    case 'replay': {
      const { part, parts } = value;
      const strokes = Array.isArray(value['strokes']) ? value['strokes'].map(readPiece) : [null];
      if (!isCount(turn) || !isCount(part) || !isCount(parts) || strokes.some((piece) => piece === null)) return null;
      return { type, turn, part, parts, strokes: strokes as Piece[] };
    }
    case 'chat':
      return typeof value['player'] === 'string' && typeof value['text'] === 'string' ? { type, player: value['player'], text: value['text'] } : null;
    case 'guessed':
      return typeof value['player'] === 'string' && isCount(value['points']) ? { type, player: value['player'], points: value['points'] } : null;
    case 'reveal':
      return isCount(turn) && typeof value['drawer'] === 'string' && typeof value['word'] === 'string'
        ? { type, turn, drawer: value['drawer'], word: value['word'] }
        : null;
    default:
      return null;
  }
}

const widthOf = (size: number) => (SIZES.find((entry) => entry.size === size) ?? SIZES[1]).width;

/** Paints `strokes` on a canvas `width` by `height` pixels: round ends, curves through the points' midpoints. */
export function paint(context: CanvasRenderingContext2D, strokes: readonly Stroke[], width: number, height: number) {
  context.clearRect(0, 0, width, height);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const { points, color, size } of strokes) {
    const at = points.map(([x, y]) => [x * width, y * height] as const);
    const first = at[0];
    if (!first) continue;
    const line = Math.max(1, widthOf(size) * width);
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = line;
    context.beginPath();
    if (at.length === 1) {
      context.arc(first[0], first[1], line / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.moveTo(first[0], first[1]);
    for (let index = 1; index < at.length - 1; index += 1) {
      const [x, y] = at[index]!;
      const [nextX, nextY] = at[index + 1]!;
      context.quadraticCurveTo(x, y, (x + nextX) / 2, (y + nextY) / 2);
    }
    const last = at[at.length - 1]!;
    context.lineTo(last[0], last[1]);
    context.stroke();
  }
}
