import './soccer.css';

import type { GameProps, GameResultProps } from '../game';
import { clock, useRemaining } from '../time';
import type { SoccerResult, SoccerView, Team } from './index';
import { kick } from './kick';

const TEAMS: readonly Team[] = ['a', 'b'];
const NAMES: Record<Team, string> = { a: 'A팀', b: 'B팀' };

/** Both teams' goals, the viewer's team marked. */
function Score({ score, team }: { score: Record<Team, number>; team: Team | null }) {
  return (
    <ol className="mg-game-scores" aria-label="점수">
      {TEAMS.map((side) => (
        <li key={side} aria-current={side === team ? 'true' : undefined}>
          <i className="mg-soccer-swatch" data-team={side} aria-hidden="true" />
          <span>{NAMES[side]}</span>
          {side === team && <span className="mg-badge">내 팀</span>}
          <b>{score[side]}</b>
        </li>
      ))}
    </ol>
  );
}

/** While it plays: the time left (standing still through a kickoff), the score, and the kick for a player. */
export function SoccerPanel({ view, me, act, serverNow }: GameProps<SoccerView>) {
  const left = useRemaining(view.endsAt, serverNow);
  const kickoff = view.phase === 'kickoff' ? view.kickoff : null;
  return (
    <div className="mg-game-hud">
      <div className="mg-soccer-clock">
        <p className="mg-game-timer" role="timer" aria-label="남은 시간">
          {clock(kickoff ? Math.max(0, view.endsAt - kickoff.until) : left)}
        </p>
        {kickoff && <span className="mg-badge">킥오프</span>}
      </div>
      <Score score={view.score} team={view.team} />
      {me && view.team && (
        <div className="mg-game-actions">
          <button
            type="button"
            className="mg-btn is-primary is-wide mg-soccer-kick"
            disabled={!!kickoff}
            aria-keyshortcuts="F"
            onClick={() => kick(act)}
          >
            차기 <kbd aria-hidden="true">F</kbd>
          </button>
        </div>
      )}
    </div>
  );
}

/** Once it has ended: who won, the score, and who scored. */
export function SoccerScore({ result, view, session }: GameResultProps<SoccerView, SoccerResult>) {
  return (
    <div className="mg-game-hud">
      <p className="mg-soccer-verdict">{result.winner ? `${NAMES[result.winner]}이 이겼어요` : '비겼어요'}</p>
      <Score score={result.score} team={view.team} />
      {result.scorers.length > 0 && (
        <ol className="mg-game-scores" aria-label="골">
          {result.scorers.map((scorer) => (
            <li key={scorer.id} aria-current={scorer.id === session.you ? 'true' : undefined}>
              <i className="mg-soccer-swatch" data-team={scorer.team} aria-hidden="true" />
              <span>{scorer.name}</span>
              <b>{scorer.goals}골</b>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
