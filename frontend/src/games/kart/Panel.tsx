import './kart.css';

import type { GameProps, GameResultProps } from '../game';
import { clock, useRemaining } from '../time';
import type { KartOutcome, KartRacer, KartView } from './index';
import { raceTime } from './route';

/** The lap a racer is on, as `2/3`: the laps done and one, at most the race's. */
export const lapOf = (lap: number, laps: number) => `${Math.min(lap + 1, laps)}/${laps}`;

function Closing({ endsAt, serverNow }: { endsAt: number; serverNow: () => number }) {
  const left = useRemaining(endsAt, serverNow);
  return (
    <p className="mg-kart-closing" role="timer">
      마감 <span className="mg-game-timer">{clock(left)}</span>
    </p>
  );
}

function Racer({ racer, laps, mine }: { racer: KartRacer; laps: number; mine: boolean }) {
  return (
    <li aria-current={mine || undefined}>
      <i>{racer.rank}위</i>
      <span>{racer.name}</span>
      {racer.bot && <small className="mg-badge">봇</small>}
      <b>{racer.finishedAt === null ? lapOf(racer.lap, laps) : raceTime(racer.finishedAt)}</b>
    </li>
  );
}

/** The race as it stands: every kart in order with its lap or its time, and the close once someone has finished. */
export function KartPanel({ view, session, serverNow }: GameProps<KartView>) {
  const someoneFinished = view.racers.some((racer) => racer.finishedAt !== null);
  return (
    <div className="mg-game-hud mg-kart">
      {someoneFinished && view.phase === 'race' && <Closing endsAt={view.endsAt} serverNow={serverNow} />}
      <ol className="mg-game-scores" aria-label="순위">
        {view.racers.map((racer) => (
          <Racer key={racer.id} racer={racer} laps={view.laps} mine={racer.id === session.you} />
        ))}
      </ol>
    </div>
  );
}

/** The final order: times for those who finished, the lap reached for the others. */
export function KartResult({ result, view, session }: GameResultProps<KartView, KartOutcome>) {
  const mine = result.ranking.find((racer) => racer.id === session.you);
  return (
    <div className="mg-game-hud mg-kart">
      {mine && (
        <p className="mg-kart-place">
          <b>{mine.rank}위</b>
          {mine.finishedAt !== null && <span>{raceTime(mine.finishedAt)}</span>}
        </p>
      )}
      <ol className="mg-game-scores" aria-label="최종 순위">
        {result.ranking.map((racer) => (
          <li key={racer.id} aria-current={racer.id === session.you || undefined}>
            <i>{racer.rank}위</i>
            <span>{racer.name}</span>
            {racer.bot && <small className="mg-badge">봇</small>}
            <b>{racer.finishedAt === null ? `${racer.laps}/${view.laps}바퀴` : raceTime(racer.finishedAt)}</b>
          </li>
        ))}
      </ol>
    </div>
  );
}
