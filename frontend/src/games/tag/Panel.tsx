import './tag.css';

import type { GameProps, GameResultProps } from '../game';
import { clock, useRemaining } from '../time';
import type { TagResult, TagView } from './index';

/** Time into the game, `m:ss`, as a clock on the wall reads. */
const elapsed = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** While it plays: the viewer's role, the time until the its may catch and then the time left, how many are which. */
export function TagPanel({ view, serverNow }: GameProps<TagView>) {
  const head = useRemaining(view.safeUntil, serverNow);
  const left = useRemaining(view.endsAt, serverNow);
  const waiting = head > 0;
  return (
    <div className="mg-game-hud">
      {view.role && <p className={`mg-tag-role is-${view.role}`}>{view.role === 'it' ? '술래예요' : '도망자예요'}</p>}
      <div className="mg-tag-clock">
        {waiting && <span aria-hidden="true">술래 출발까지</span>}
        <p className="mg-game-timer" role="timer" aria-label={waiting ? '술래 출발까지' : '남은 시간'}>
          {clock(waiting ? head : left)}
        </p>
      </div>
      <ul className="mg-game-scores" aria-label="인원">
        <li>
          <span>술래</span>
          <b>{view.counts.its}</b>
        </li>
        <li>
          <span>도망자</span>
          <b>{view.counts.runners}</b>
        </li>
      </ul>
    </div>
  );
}

/** Once it has ended: who won, then the runners left, who was caught (last caught first, with when) and who started it. */
export function TagOutcome({ result, session }: GameResultProps<TagView, TagResult>) {
  const mine = (id: string) => (id === session.you ? 'true' : undefined);
  return (
    <>
      <p className={`mg-tag-winner is-${result.winner}`}>{result.winner === 'its' ? '술래가 이겼어요' : '도망자가 이겼어요'}</p>
      <ol className="mg-game-scores" aria-label="결과">
        {result.runners.map((entry) => (
          <li key={entry.id} aria-current={mine(entry.id)}>
            <i>생존</i>
            <span>{entry.name}</span>
          </li>
        ))}
        {[...result.caught].reverse().map((entry) => (
          <li key={entry.id} aria-current={mine(entry.id)}>
            <i>잡힘</i>
            <span>{entry.name}</span>
            <b>{elapsed(entry.time)}</b>
          </li>
        ))}
        {result.its.map((entry) => (
          <li key={entry.id} aria-current={mine(entry.id)}>
            <i>술래</i>
            <span>{entry.name}</span>
          </li>
        ))}
      </ol>
    </>
  );
}
