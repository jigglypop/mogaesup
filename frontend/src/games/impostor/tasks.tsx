import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

import { useRemaining } from '../time';
import type { TaskKind } from './index';

export const TASK_NAMES: Record<TaskKind, string> = {
  wires: '전선 연결',
  swipe: '카드 긁기',
  download: '데이터 받기',
  numbers: '숫자 누르기',
  calibrate: '계기 맞추기',
  fuel: '연료 채우기',
};

type TaskGameProps = { onDone: () => void; readyAt: number; serverNow: () => number };

/** `items` in a random order. */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [out[index], out[other]] = [out[other]!, out[index]!];
  }
  return out;
}

/** Calls `onDone` once, when `done` first turns true. */
function useDone(done: boolean, onDone: () => void) {
  const called = useRef(false);
  useEffect(() => {
    if (!done || called.current) return;
    called.current = true;
    onDone();
  }, [done, onDone]);
}

/** The crew palette (tokens.css `--mg-crew-*`) as a CSS colour. */
export const crewColor = (index: number) => `var(--mg-crew-${index % 12})`;

/** Wires of four colours, shuffled on each side: pick one on the left, then its colour on the right. */
const WIRES = [0, 1, 5, 3];
function Wires({ onDone }: TaskGameProps) {
  const [left] = useState(() => shuffled(WIRES));
  const [right] = useState(() => shuffled(WIRES));
  const [picked, setPicked] = useState<number | null>(null);
  const [joined, setJoined] = useState<number[]>([]);
  useDone(joined.length === WIRES.length, onDone);
  const y = (side: number[], wire: number) => ((side.indexOf(wire) + 0.5) / side.length) * 100;
  return (
    <div className="mg-wires">
      <div className="mg-wires-side" role="group" aria-label="왼쪽 전선">
        {left.map((wire) => (
          <button
            key={wire}
            type="button"
            aria-label={`왼쪽 ${wire + 1}`}
            aria-pressed={picked === wire}
            disabled={joined.includes(wire)}
            style={{ '--wire': crewColor(wire) } as CSSProperties}
            onClick={() => setPicked(wire)}
          />
        ))}
      </div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {joined.map((wire) => (
          <line key={wire} x1="0" y1={y(left, wire)} x2="100" y2={y(right, wire)} style={{ stroke: crewColor(wire) }} />
        ))}
      </svg>
      <div className="mg-wires-side" role="group" aria-label="오른쪽 전선">
        {right.map((wire) => (
          <button
            key={wire}
            type="button"
            aria-label={`오른쪽 ${wire + 1}`}
            disabled={joined.includes(wire)}
            style={{ '--wire': crewColor(wire) } as CSSProperties}
            onClick={() => {
              if (picked === wire) setJoined([...joined, wire]);
              setPicked(null);
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** A card swiped across the reader at a steady hand: not under 0.4 s, not over 1.6 s (the keys swipe it as they go). */
const SWIPE_FAST = 400;
const SWIPE_SLOW = 1_600;
function Swipe({ onDone }: TaskGameProps) {
  const [at, setAt] = useState(0);
  const [said, setSaid] = useState('');
  const [done, setDone] = useState(false);
  const started = useRef<number | null>(null);
  const keys = useRef(false);
  useDone(done, onDone);
  const move = (value: number) => {
    if (done) return;
    if (value > 0 && started.current === null) started.current = performance.now();
    setAt(value);
    if (value < 100) return;
    const took = performance.now() - (started.current ?? performance.now());
    started.current = null;
    if (keys.current || (took >= SWIPE_FAST && took <= SWIPE_SLOW)) {
      setDone(true);
      setSaid('');
      return;
    }
    setSaid(took < SWIPE_FAST ? '너무 빨라요' : '너무 느려요');
    setAt(0);
  };
  return (
    <div className="mg-swipe">
      <input
        type="range"
        min={0}
        max={100}
        value={at}
        aria-label="카드"
        disabled={done}
        onPointerDown={() => {
          keys.current = false;
        }}
        onKeyDown={() => {
          keys.current = true;
        }}
        onPointerUp={() => {
          if (!done && at < 100) {
            started.current = null;
            setAt(0);
          }
        }}
        onChange={(event) => move(Number(event.target.value))}
      />
      {said && <p role="status">{said}</p>}
    </div>
  );
}

/** One to ten, scattered: pressed in order; a wrong one starts over. */
function Numbers({ onDone }: TaskGameProps) {
  const [order] = useState(() => shuffled(Array.from({ length: 10 }, (_, index) => index + 1)));
  const [next, setNext] = useState(1);
  useDone(next > 10, onDone);
  return (
    <div className="mg-numbers" role="group" aria-label="숫자">
      {order.map((value) => (
        <button key={value} type="button" className="mg-btn is-small" aria-pressed={value < next} onClick={() => setNext(value === next ? next + 1 : 1)}>
          {value}
        </button>
      ))}
    </div>
  );
}

/** A needle sweeping back and forth: stopped inside the mark three times running. */
const SWEEP = 1_600;
const MARK: [number, number] = [40, 60];
function Calibrate({ onDone }: TaskGameProps) {
  const since = useRef(performance.now());
  const [hits, setHits] = useState(0);
  useDone(hits >= 3, onDone);
  const stop = () => {
    const phase = ((performance.now() - since.current) % SWEEP) / SWEEP;
    const at = (phase < 0.5 ? phase * 2 : 2 - phase * 2) * 100;
    setHits(at >= MARK[0] && at <= MARK[1] ? hits + 1 : 0);
  };
  return (
    <div className="mg-calibrate">
      <div className="mg-calibrate-track" aria-hidden="true">
        <span className="mg-calibrate-mark" style={{ left: `${MARK[0]}%`, width: `${MARK[1] - MARK[0]}%` }} />
        <span className="mg-calibrate-needle" style={{ animationDuration: `${SWEEP}ms` }} />
      </div>
      <div className="mg-game-actions">
        <button type="button" className="mg-btn is-small is-primary" disabled={hits >= 3} onClick={stop}>
          맞추기
        </button>
        <b>{Math.min(hits, 3)}/3</b>
      </div>
    </div>
  );
}

/** A tank filled while the button is held down. */
const FILL = 2_500;
function Fuel({ onDone }: TaskGameProps) {
  const [level, setLevel] = useState(0);
  const [held, setHeld] = useState(false);
  useDone(level >= 100, onDone);
  useEffect(() => {
    if (!held || level >= 100) return;
    const timer = setInterval(() => setLevel((value) => Math.min(100, value + 10_000 / FILL / 10)), 100);
    return () => clearInterval(timer);
  }, [held, level >= 100]);
  const press = (down: boolean) => (event: PointerEvent | KeyboardEvent) => {
    if ('key' in event && event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    setHeld(down);
  };
  return (
    <div className="mg-fuel">
      <div className="mg-progress" role="progressbar" aria-label="연료" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level)}>
        <i style={{ width: `${level}%` }} />
      </div>
      <button
        type="button"
        className="mg-btn is-small is-primary"
        aria-pressed={held}
        disabled={level >= 100}
        onPointerDown={press(true)}
        onPointerUp={press(false)}
        onPointerLeave={press(false)}
        onKeyDown={press(true)}
        onKeyUp={press(false)}
      >
        채우기
      </button>
    </div>
  );
}

/** Data coming in, as long as it takes. */
const DOWNLOAD = 6_000;
function Download({ onDone, readyAt, serverNow }: TaskGameProps) {
  const left = useRemaining(readyAt, serverNow, 100);
  useDone(left <= 0, onDone);
  const share = Math.max(0, Math.min(100, 100 - (left / DOWNLOAD) * 100));
  return (
    <div className="mg-progress" role="progressbar" aria-label="받는 중" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share)}>
      <i style={{ width: `${share}%` }} />
    </div>
  );
}

const GAMES: Record<TaskKind, (props: TaskGameProps) => React.JSX.Element> = {
  wires: Wires,
  swipe: Swipe,
  download: Download,
  numbers: Numbers,
  calibrate: Calibrate,
  fuel: Fuel,
};

/** The task of `kind`, played on the page; `onDone` once it is solved. */
export function TaskGame({ kind, ...props }: TaskGameProps & { kind: TaskKind }) {
  const Game = GAMES[kind];
  return <Game {...props} />;
}
