import './redlight.css';

import type { GameProps, GameResultProps } from '../game';
import { clock, useRemaining } from '../time';
import type { RedlightResult, RedlightView } from './index';

/** What is called out in each phase. */
const CALLS = { ready: '준비', green: '무궁화 꽃이 피었습니다', red: '멈춤' } as const;

/** A finishing time, to a tenth of a second. */
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}초`;

/** Where a time places among `finished`: 1 for the fastest, and the same time, the same place. */
const rankOf = (finished: readonly { time: number }[], time: number) => 1 + finished.filter((entry) => entry.time < time).length;

/** The viewer's own state, said briefly. */
function stateText(view: RedlightView, you: string): string | null {
  if (view.state === 'running') return '달리는 중이에요';
  if (view.state === 'out') return '탈락했어요';
  const mine = view.finished.find((entry) => entry.id === you);
  if (view.state === 'finished') return mine ? `도착했어요 · ${rankOf(view.finished, mine.time)}위 ${seconds(mine.time)}` : '도착했어요';
  return null;
}

/** While it plays: the call, big; the time to the start or to the end; the viewer's state; how many run, arrived, are out. */
export function RedlightPanel({ view, session, serverNow }: GameProps<RedlightView>) {
  const ready = view.phase === 'ready';
  const left = useRemaining(ready ? view.phaseEndsAt : view.endsAt, serverNow);
  const state = stateText(view, session.you);
  return (
    <div className="mg-game-hud">
      <p className={`mg-redlight-call is-${view.phase}`} role="status">
        {CALLS[view.phase]}
      </p>
      <p className="mg-game-timer" role="timer" aria-label={ready ? '출발까지' : '남은 시간'}>
        {clock(left)}
      </p>
      {state && (
        <p className={`mg-redlight-state is-${view.state}`}>{state}</p>
      )}
      <ul className="mg-game-scores" aria-label="인원">
        <li>
          <span>달리는 중</span>
          <b>{view.counts.running}</b>
        </li>
        <li>
          <span>도착</span>
          <b>{view.counts.finished}</b>
        </li>
        <li>
          <span>탈락</span>
          <b>{view.counts.out}</b>
        </li>
      </ul>
    </div>
  );
}

/** Once it has ended: who arrived, fastest first, then who did not and who went out. */
export function RedlightRanking({ result, session }: GameResultProps<RedlightView, RedlightResult>) {
  const mine = (id: string) => (id === session.you ? 'true' : undefined);
  return (
    <ol className="mg-game-scores" aria-label="순위">
      {result.finished.map((entry) => (
        <li key={entry.id} aria-current={mine(entry.id)}>
          <i>{entry.rank}위</i>
          <span>{entry.name}</span>
          <b>{seconds(entry.time)}</b>
        </li>
      ))}
      {result.unfinished.map((entry) => (
        <li key={entry.id} aria-current={mine(entry.id)}>
          <i />
          <span>{entry.name}</span>
          <b>미도착</b>
        </li>
      ))}
      {result.out.map((entry) => (
        <li key={entry.id} aria-current={mine(entry.id)}>
          <i />
          <span>{entry.name}</span>
          <b>탈락</b>
        </li>
      ))}
    </ol>
  );
}
