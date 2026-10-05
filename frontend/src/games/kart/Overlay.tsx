import './kart.css';

import { useEffect, useRef, useState } from 'react';

import type { GameProps } from '../game';
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

/**
 * Over the page while 카트 runs: the countdown and 출발, the lap and place, the item slot (Space or Ctrl, or a press),
 * a word when a booster fires or a bubble catches the viewer, and the finish.
 */
export function KartOverlay({ view, session, act, onEvent, serverNow }: GameProps<KartView>) {
  const mine = view.racers.find((racer) => racer.id === session.you) ?? null;
  const starting = view.phase === 'countdown' || serverNow() < view.startsAt + GO;
  const [splash, setSplash] = useState<{ key: number; text: string; tone: 'boost' | 'trap' } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const now = useServerClock(serverNow, starting);
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
