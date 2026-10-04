import type { GameProps, GameResultProps } from '../game';
import { clock, useRemaining } from '../time';
import type { TreasureResult, TreasureView } from './index';

/** While it plays: the time left and the scores, best first, the viewer's own marked. */
export function TreasurePanel({ view, session, serverNow }: GameProps<TreasureView>) {
  const left = useRemaining(view.endsAt, serverNow);
  const scores = [...view.scores].sort((a, b) => b.score - a.score);
  return (
    <div className="mg-game-hud">
      <p className="mg-game-timer" role="timer" aria-label="남은 시간">
        {clock(left)}
      </p>
      <ol className="mg-game-scores" aria-label="점수">
        {scores.map((entry) => (
          <li key={entry.id} aria-current={entry.id === session.you ? 'true' : undefined}>
            <span>{entry.name}</span>
            <b>{entry.score}</b>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Once it has ended: the places, ties sharing one. */
export function TreasureRanking({ result, session }: GameResultProps<TreasureView, TreasureResult>) {
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
