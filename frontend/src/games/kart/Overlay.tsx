import './kart.css';

import { useEffect, useRef, useState } from 'react';

import type { GameProps } from '../game';
import { useTouchScreen } from '../WalkingControls';
import { kartTouchControls, useKartTouchControls, type KartControl } from './controls';
import type { KartEvent, KartItem, KartView } from './index';
import { lapOf } from './Panel';
import { raceTime } from './route';

export const ITEM_NAMES: Record<KartItem, string> = { booster: '부스터', bubble: '물풍선' };
/** How long `출발` stays after the start, and a splash for an item. */
const GO = 1_000;
const SPLASH = 1_400;

/** The server's clock, read every `every` ms while `running`. */
function useServerClock(serverNow: () => number, running: boolean, every = 100): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    setNow(serverNow());
    if (!running) return undefined;
    const timer = setInterval(() => setNow(serverNow()), every);
    return () => clearInterval(timer);
  }, [serverNow, running, every]);
  return now;
}

type TouchButton = { control: KartControl; label: string };
/** The left hand brakes and steers; the right drifts and drives. */
const LEFT: readonly TouchButton[] = [
  { control: 'back', label: '뒤로' },
  { control: 'left', label: '왼쪽' },
  { control: 'right', label: '오른쪽' },
];
const RIGHT: readonly TouchButton[] = [
  { control: 'drift', label: '드리프트' },
  { control: 'forward', label: '앞으로' },
];
const ORDER: readonly KartControl[] = ['forward', 'back', 'left', 'right', 'drift'];

/** An arrow pointing the way of `control`. */
function Arrow({ control }: { control: KartControl }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" data-way={control}>
      <path d="M12 5l7.5 11h-15z" />
    </svg>
  );
}

/**
 * The kart's buttons on a touch screen: every finger holds its own button (steering, the throttle and a drift at once),
 * and lets go of it alone; everything is let go when the window or the tab loses focus, while `disabled` (the
 * countdown) and when they go. Enter holds a focused button as a finger would.
 */
function TouchControls({ disabled }: { disabled: boolean }) {
  const held = useKartTouchControls();
  useEffect(() => {
    const release = (event: PointerEvent) => kartTouchControls.release(event.pointerId);
    const reset = () => kartTouchControls.reset();
    const hidden = () => {
      if (document.visibilityState !== 'visible') reset();
    };
    reset();
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', hidden);
      reset();
    };
  }, []);
  useEffect(() => {
    if (disabled) kartTouchControls.reset();
  }, [disabled]);
  const button = ({ control, label }: TouchButton) => {
    const key = -ORDER.indexOf(control) - 1;
    return (
      <button
        key={control}
        type="button"
        className="mg-kart-control mg-glass"
        data-control={control}
        aria-label={label}
        aria-pressed={held[control]}
        disabled={disabled}
        onPointerDown={(event) => {
          if (event.button !== 0 || disabled) return;
          event.preventDefault();
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // The window's listeners let go of a finger the button could not capture.
          }
          kartTouchControls.press(control, event.pointerId);
        }}
        onPointerUp={(event) => kartTouchControls.release(event.pointerId)}
        onPointerCancel={(event) => kartTouchControls.release(event.pointerId)}
        onLostPointerCapture={(event) => kartTouchControls.release(event.pointerId)}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (disabled || event.key !== 'Enter') return;
          event.preventDefault();
          kartTouchControls.press(control, key);
        }}
        onKeyUp={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          kartTouchControls.release(key);
        }}
        onBlur={() => kartTouchControls.release(key)}
      >
        {control === 'drift' ? <span>{label}</span> : <Arrow control={control} />}
      </button>
    );
  };
  return (
    <div className="mg-kart-touch" role="group" aria-label="카트 조작">
      <div className="mg-kart-touch-pad">{LEFT.map(button)}</div>
      <div className="mg-kart-touch-actions">{RIGHT.map(button)}</div>
    </div>
  );
}

/**
 * Over the page while 카트 runs: the countdown and 출발, the lap and place, the item slot (Space or Ctrl, or a press),
 * a word when a booster fires or a bubble catches the viewer, the finish, and on a touch screen the kart's buttons.
 */
export function KartOverlay({ view, session, act, onEvent, serverNow }: GameProps<KartView>) {
  const mine = view.racers.find((racer) => racer.id === session.you) ?? null;
  const starting = view.phase === 'countdown' || serverNow() < view.startsAt + GO;
  const [splash, setSplash] = useState<{ key: number; text: string; tone: 'boost' | 'trap' } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const now = useServerClock(serverNow, starting);
  const touch = useTouchScreen();
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(
    () =>
      onEvent((raw) => {
        const event = raw as KartEvent;
        if (event.type !== 'boost' && event.type !== 'trapped') return;
        clearTimeout(timer.current);
        setSplash({ key: Date.now(), text: event.type === 'boost' ? ITEM_NAMES.booster : ITEM_NAMES.bubble, tone: event.type === 'boost' ? 'boost' : 'trap' });
        timer.current = setTimeout(() => setSplash(null), SPLASH);
      }),
    [onEvent],
  );
  if (view.phase === 'ended') return null;
  const count = Math.ceil((view.startsAt - now) / 1000);
  const item = view.me?.item ?? null;
  const finished = mine?.finishedAt ?? null;
  const driving = !!mine && !!view.me && finished === null;
  return (
    <>
      {now < view.startsAt + GO && (
        <div key={count} className="mg-kart-countdown" role="status" data-go={count <= 0 || undefined}>
          {count > 0 ? count : '출발'}
        </div>
      )}
      {mine && view.me && (
        <div className="mg-kart-hud mg-glass" role="group" aria-label="내 기록">
          <span>
            바퀴 <b>{lapOf(view.me.lap, view.laps)}</b>
          </span>
          <span>
            <b>{mine.rank}위</b>/{view.racers.length}
          </span>
        </div>
      )}
      {mine && finished === null && (
        <button
          type="button"
          className="mg-kart-item mg-glass"
          data-item={item ?? undefined}
          disabled={!item || view.phase !== 'race'}
          aria-label={item ? `아이템 ${ITEM_NAMES[item]}` : '아이템 없음'}
          onClick={() => act({ do: 'item' })}
        >
          <b>{item ? ITEM_NAMES[item] : '—'}</b>
          <kbd>Space</kbd>
        </button>
      )}
      {touch && driving && <TouchControls key={`${session.you}:${view.startsAt}`} disabled={view.phase !== 'race'} />}
      {finished !== null && mine && (
        <div className="mg-kart-finish" role="status">
          <b>{mine.rank}위</b>
          <span>{raceTime(finished)}</span>
          <ol className="mg-kart-board mg-glass" aria-label="순위">
            {view.racers.map((racer) => (
              <li key={racer.id} aria-current={racer.id === session.you || undefined}>
                <i>{racer.rank}</i>
                <span>{racer.name}</span>
                <b>{racer.finishedAt === null ? lapOf(racer.lap, view.laps) : raceTime(racer.finishedAt)}</b>
              </li>
            ))}
          </ol>
        </div>
      )}
      {splash && finished === null && (
        <div key={splash.key} className="mg-kart-splash" data-tone={splash.tone} role="status">
          {splash.text}
        </div>
      )}
    </>
  );
}
