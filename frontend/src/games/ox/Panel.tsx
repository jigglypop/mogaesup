import './ox.css';

import type { GameProps, GameResultProps } from '../game';
import { clock, useRemaining } from '../time';
import type { OxResult, OxView, OxZone } from './index';

const MARK: Record<OxZone, string> = { o: 'O', x: 'X' };

function Mark({ zone }: { zone: OxZone }) {
  return (
    <b className="mg-ox-mark" data-zone={zone}>
      {MARK[zone]}
    </b>
  );
}

/** While it plays: the statement, the time left, the answer once it shows, where the viewer stands and how many are in. */
export function OxPanel({ view, serverNow }: GameProps<OxView>) {
  const left = useRemaining(view.endsAt, serverNow);
  const answer = view.phase === 'answer' ? view.answer : null;
  const { me } = view;
  return (
    <div className="mg-game-hud">
      <div className="mg-ox-top">
        <span className="mg-badge">
          문제 {view.round}/{view.rounds}
        </span>
        <p className="mg-game-timer" role="timer" aria-label="남은 시간">
          {clock(left)}
        </p>
      </div>
      <p className="mg-ox-statement">{view.statement}</p>
      {answer && (
        <div className="mg-ox-answer" role="status">
          <p>
            정답 <Mark zone={answer} />
          </p>
          <p>{view.fallen.length ? `탈락 ${view.fallen.map((person) => person.name).join(', ')}` : '탈락 없어요'}</p>
        </div>
      )}
      <dl className="mg-ox-facts">
        {me && (
          <div>
            <dt>내 자리</dt>
            <dd>{me.zone ? <Mark zone={me.zone} /> : '없음'}</dd>
          </div>
        )}
        <div>
          <dt>생존</dt>
          <dd>{view.survivors.length}명</dd>
        </div>
      </dl>
      {me?.state === 'out' && <p className="mg-ox-out">탈락했어요</p>}
    </div>
  );
}

/** Once it has ended: who is left in, then who went out, latest first; those out at one statement share a place. */
export function OxRanking({ result, session }: GameResultProps<OxView, OxResult>) {
  const rows = [
    ...result.winners.map((person) => ({ ...person, rank: 1, note: '우승' })),
    ...result.out.map((person) => ({
      ...person,
      rank: 1 + result.winners.length + result.out.filter((other) => other.round > person.round).length,
      note: `${person.round}번 문제 탈락`,
    })),
  ];
  return (
    <ol className="mg-game-scores" aria-label="순위">
      {rows.map((row) => (
        <li key={row.id} aria-current={row.id === session.you ? 'true' : undefined}>
          <i>{row.rank}위</i>
          <span>{row.name}</span>
          <b>{row.note}</b>
        </li>
      ))}
    </ol>
  );
}
