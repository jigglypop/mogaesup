import './draw.css';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

import { Icon } from '../../ui/icons';
import { nextTabIndex } from '../../ui/tabs';
import type { GameProps, GameResultProps } from '../game';
import { clock, useRemaining } from '../time';
import { ASPECT, Board, MAX_GUESS, onGrid, paint, PALETTE, Pen, readEvent, SEND_EVERY_MS, SIZES, type Point } from './board';
import type { DrawResult, DrawView } from './index';

/** Lines the chat keeps. */
const MAX_LINES = 40;
/** How wide each size's mark is in the size picker, in pixels. */
const MARKS = [4, 8, 14];

type Line = { id: number; kind: 'chat' | 'guessed' | 'answer'; name: string; text: string };

type Option<T> = { value: T; name: string };

/** A row of radio buttons: one stop in the Tab order, arrows and Home/End move the choice. */
function Choice<T extends string | number>({ label, options, value, onChange, className, render }: {
  label: string;
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  className: string;
  render: (option: Option<T>) => { content?: ReactNode; color?: string };
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const chosen = Math.max(0, options.findIndex((option) => option.value === value));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextTabIndex(event.key, chosen, options.length);
    if (next === null) return;
    // The island walks on arrow keys too; here they only move the choice.
    event.preventDefault();
    event.stopPropagation();
    onChange(options[next]!.value);
    buttons.current[next]?.focus();
  };
  return (
    <div className={className} role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((option, index) => {
        const { content, color } = render(option);
        return (
          <button
            key={option.value}
            ref={(button) => {
              buttons.current[index] = button;
            }}
            type="button"
            role="radio"
            aria-checked={index === chosen}
            aria-label={option.name}
            tabIndex={index === chosen ? 0 : -1}
            style={color ? { background: color } : undefined}
            onClick={() => onChange(option.value)}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

/** The board: paints the turn's strokes at the canvas's own size, and lets the drawer draw on it with a pointer. */
function Sketch({ board, pen, editable, color, size }: { board: Board; pen: Pen; editable: boolean; color: string; size: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pointer = useRef<number | null>(null);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return undefined;
    // At most one paint a frame, however many strokes came in it.
    let scheduled = false;
    let frame = 0;
    const draw = () => {
      scheduled = false;
      const context = element.getContext('2d');
      if (context) paint(context, board.strokes, element.width, element.height);
    };
    // Sharp at any width: the canvas has as many pixels as it shows (up to twice for dense screens).
    const fit = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(element.clientWidth * ratio));
      const height = Math.max(1, Math.round(width / ASPECT));
      if (element.width !== width || element.height !== height) {
        element.width = width;
        element.height = height;
      }
      draw();
    };
    fit();
    const stop = board.subscribe(() => {
      if (scheduled) return;
      scheduled = true;
      frame = requestAnimationFrame(draw);
    });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(element);
    return () => {
      stop();
      observer?.disconnect();
      if (scheduled) cancelAnimationFrame(frame);
    };
  }, [board]);

  // A line under way ends when drawing does.
  useEffect(() => {
    if (editable) return;
    pointer.current = null;
    pen.end();
  }, [editable, pen]);

  const at = (event: PointerEvent<HTMLCanvasElement>): Point => {
    const box = event.currentTarget.getBoundingClientRect();
    return [onGrid((event.clientX - box.left) / (box.width || 1)), onGrid((event.clientY - box.top) / (box.height || 1))];
  };
  const finish = (event: PointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null;
    pen.end(at(event));
  };
  return (
    <canvas
      ref={canvas}
      className="mg-draw-canvas"
      data-editable={editable || undefined}
      role="img"
      aria-label="그림판"
      onPointerDown={(event) => {
        if (!editable || pointer.current !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.preventDefault();
        if (!pen.start(at(event), color, size)) return;
        pointer.current = event.pointerId;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Not every pointer can be held; its moves still reach the canvas while it stays over it.
        }
      }}
      onPointerMove={(event) => {
        if (pointer.current === event.pointerId) pen.move(at(event));
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    />
  );
}

/**
 * While it plays: the turn, the word (the drawer's) or its length, the time left, and the board. The drawer gets the
 * palette, the sizes, 되돌리기 and 지우기; the others guess, and everyone sees the guesses and the scores.
 */
export function DrawPanel({ view, session, act, onEvent, serverNow }: GameProps<DrawView>) {
  const [board] = useState(() => new Board(view.turn));
  const [pen] = useState(() => new Pen(board));
  const [marks, setMarks] = useState({ strokes: 0, full: false });
  // Until the strokes drawn before this panel opened have come, the drawer does not draw.
  const [ready, setReady] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [color, setColor] = useState<string>(PALETTE[0].color);
  const [size, setSize] = useState(2);
  const [text, setText] = useState('');
  const awaiting = useRef(false);
  const said = useRef(0);
  const log = useRef<HTMLOListElement>(null);
  const names = useRef(new Map<string, string>());
  names.current = new Map(session.players.map((player) => [player.id, player.name]));
  const left = useRemaining(view.endsAt, serverNow);

  useEffect(
    () =>
      board.subscribe(() =>
        setMarks((marks) =>
          marks.strokes === board.strokes.length && marks.full === board.full ? marks : { strokes: board.strokes.length, full: board.full },
        ),
      ),
    [board],
  );

  // A new turn starts on a blank board; its strokes all come as they are drawn.
  useLayoutEffect(() => {
    if (view.turn <= board.turn) return;
    board.reset(view.turn);
    pen.drop();
    awaiting.current = false;
    setReady(true);
    setText('');
  }, [board, pen, view.turn]);

  // What happens on the board and in the chat; on opening, ask for what was drawn before.
  useEffect(() => {
    const say = (kind: Line['kind'], player: string, words: string) =>
      setLines((lines) => [...lines.slice(1 - MAX_LINES), { id: (said.current += 1), kind, name: names.current.get(player) ?? '', text: words }]);
    const stop = onEvent((raw) => {
      const event = readEvent(raw);
      if (!event) return;
      switch (event.type) {
        case 'stroke':
        case 'clear':
        case 'undo':
          if (event.turn < board.turn) return;
          if (event.turn > board.turn) board.reset(event.turn);
          if (event.type === 'stroke') board.add(event.stroke);
          else if (event.type === 'undo') board.undo();
          else board.clear();
          return;
        case 'replay':
          if (!awaiting.current || event.turn < board.turn) return;
          if (event.part === 0 || event.turn > board.turn) board.reset(event.turn);
          for (const piece of event.strokes) board.add(piece);
          if (event.part + 1 >= event.parts) {
            awaiting.current = false;
            setReady(true);
          }
          return;
        case 'chat':
          say('chat', event.player, event.text);
          return;
        case 'guessed':
          say('guessed', event.player, '');
          return;
        case 'reveal':
          say('answer', event.drawer, event.word);
          return;
      }
    });
    awaiting.current = true;
    if (!act({ replay: true })) {
      awaiting.current = false;
      setReady(true);
    }
    return () => {
      stop();
      awaiting.current = false;
    };
  }, [act, board, onEvent]);

  // The drawer's points go out in pieces, one message every SEND_EVERY_MS; what is left when the turn ends is dropped.
  const drawing = view.role === 'drawer' && view.phase === 'drawing';
  useEffect(() => {
    if (!drawing) {
      pen.drop();
      return undefined;
    }
    const timer = setInterval(() => {
      const message = pen.next();
      if (message) act(message);
    }, SEND_EVERY_MS);
    return () => clearInterval(timer);
  }, [act, drawing, pen]);

  useLayoutEffect(() => {
    const list = log.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [lines]);

  const guessed = view.guessed.includes(session.you);
  const guessing = view.role === 'guesser' && view.phase === 'drawing' && !guessed;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const guess = text.normalize('NFC').trim();
    if (!guessing || !guess) return;
    if (act({ guess })) setText('');
  };
  const scores = [...view.scores].sort((a, b) => b.score - a.score);

  let word: ReactNode;
  if (view.phase === 'reveal') {
    word = (
      <>
        <small>정답</small>
        <b>{view.word}</b>
      </>
    );
  } else if (view.word !== null) {
    word = (
      <>
        <small>제시어</small>
        <b>{view.word}</b>
      </>
    );
  } else {
    word = <b>{view.letters}글자</b>;
  }

  return (
    <div className="mg-draw">
      <div className="mg-draw-head">
        <span className="mg-draw-turn">
          <em className="mg-sr">차례 </em>
          {view.turn}/{view.turns}
        </span>
        <p className="mg-draw-word">{word}</p>
        <p className="mg-game-timer" role="timer" aria-label="남은 시간">
          {clock(left)}
        </p>
      </div>
      <div className="mg-draw-board">
        <Sketch board={board} pen={pen} editable={drawing && ready && !marks.full} color={color} size={size} />
      </div>
      {drawing && (
        <div className="mg-draw-tools">
          <Choice
            label="색"
            className="mg-draw-palette"
            options={PALETTE.map((entry) => ({ value: entry.color, name: entry.name }))}
            value={color}
            onChange={setColor}
            render={(option) => ({ color: option.value })}
          />
          <div className="mg-draw-row">
            <Choice
              label="굵기"
              className="mg-tabs is-fit mg-draw-sizes"
              options={SIZES.map((entry) => ({ value: entry.size, name: entry.name }))}
              value={size}
              onChange={setSize}
              render={(option) => ({ content: <i style={{ width: MARKS[option.value - 1], height: MARKS[option.value - 1] }} /> })}
            />
            <button type="button" className="mg-btn is-small" disabled={!ready || marks.strokes === 0} onClick={() => pen.undo()}>
              되돌리기
            </button>
            <button type="button" className="mg-btn is-small" disabled={!ready || marks.strokes === 0} onClick={() => pen.clear()}>
              지우기
            </button>
          </div>
          {marks.full && (
            <p className="mg-muted" role="status">
              더 그릴 수 없어요
            </p>
          )}
        </div>
      )}
      {view.role === 'guesser' && (
        <form className="mg-draw-guess" onSubmit={submit}>
          <input
            className="mg-field"
            value={text}
            maxLength={MAX_GUESS}
            placeholder={guessed ? '맞혔어요' : '정답'}
            aria-label="정답"
            enterKeyHint="send"
            autoComplete="off"
            readOnly={!guessing}
            onChange={(event) => setText(event.target.value)}
            // Letters typed here are not the island's walking keys.
            onKeyDown={(event) => {
              if (event.key !== 'Escape') event.stopPropagation();
            }}
          />
          <button type="submit" className="mg-btn is-primary" disabled={!guessing || !text.trim()}>
            보내기
          </button>
        </form>
      )}
      <ol ref={log} className="mg-draw-log" role="log" aria-label="채팅">
        {lines.map((line) => (
          <li key={line.id} className={line.kind === 'chat' ? undefined : line.kind === 'guessed' ? 'is-good' : 'is-answer'}>
            {line.kind === 'answer' ? (
              <span>정답 {line.text}</span>
            ) : (
              <>
                <b>{line.name}</b>
                <span>{line.kind === 'guessed' ? '맞혔어요' : line.text}</span>
              </>
            )}
          </li>
        ))}
      </ol>
      <ol className="mg-game-scores" aria-label="점수">
        {scores.map((entry) => (
          <li key={entry.id} aria-current={entry.id === session.you ? 'true' : undefined}>
            <span>{entry.name}</span>
            {entry.id === view.drawer && (
              <>
                <Icon name="brush" className="mg-draw-mark" />
                <em className="mg-sr">그리는 사람</em>
              </>
            )}
            {view.guessed.includes(entry.id) && (
              <>
                <Icon name="check" className="mg-draw-mark is-good" />
                <em className="mg-sr">맞혔어요</em>
              </>
            )}
            <b>{entry.score}</b>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Once it has ended: the places, ties sharing one. */
export function DrawRanking({ result, session }: GameResultProps<DrawView, DrawResult>) {
  return (
    <ol className="mg-game-scores" aria-label="순위">
      {result.ranking.map((entry) => (
        <li key={entry.id} aria-current={entry.id === session.you ? 'true' : undefined}>
          <i>{entry.rank}위</i>
          <span>{entry.name}</span>
          <b>{entry.score}점</b>
        </li>
      ))}
    </ol>
  );
}
