import './impostor.css';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import type { GameProps, GameResultProps } from '../game';
import { clock, useRemaining } from '../time';
import type { ImpostorLine, ImpostorMeeting, ImpostorOutcome, ImpostorRole, ImpostorView } from './index';
import { SABOTAGE_NAMES } from './Overlay';
import { TASK_NAMES } from './tasks';

/** The longest line the server takes. */
const MAX_TEXT = 120;
const ROLE: Record<ImpostorRole, string> = { crew: '크루', impostor: '임포스터' };
const REASON: Record<ImpostorOutcome['reason'], string> = {
  tasks: '작업을 모두 마쳤어요',
  impostorsOut: '임포스터가 모두 사라졌어요',
  parity: '임포스터가 크루만큼 남았어요',
  meltdown: '원자로가 녹아내렸어요',
};

type Act = GameProps['act'];
type Names = ReadonlyMap<string, string>;

const seconds = (ms: number) => Math.ceil(ms / 1000);

function RoleBadge({ role }: { role: ImpostorRole }) {
  return (
    <span className="mg-badge mg-impostor-badge" data-role={role}>
      {ROLE[role]}
    </span>
  );
}

/** The viewer's role, the other impostors to an impostor, and whether they are out. */
function Role({ view, names, you }: { view: ImpostorView; names: Names; you: string }) {
  if (!view.role) return null;
  const partners = (view.impostors ?? []).filter((id) => id !== you).flatMap((id) => names.get(id) ?? []);
  return (
    <p className="mg-impostor-role">
      <RoleBadge role={view.role} />
      {partners.length > 0 && <span>동료 {partners.join(', ')}</span>}
      {view.alive === false && <span className="mg-badge">탈락</span>}
    </p>
  );
}

function Progress({ done, total }: NonNullable<ImpostorView['progress']>) {
  return (
    <div className="mg-impostor-progress">
      <span>전체 작업</span>
      <div className="mg-progress" role="progressbar" aria-label="전체 작업" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <i style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
      </div>
      <b>
        {done}/{total}
      </b>
    </div>
  );
}

function Seconds({ at, serverNow }: { at: number; serverNow: () => number }) {
  return <>{seconds(useRemaining(at, serverNow))}초</>;
}

function Tasks({ view, serverNow }: { view: ImpostorView; serverNow: () => number }) {
  const fake = view.role === 'impostor';
  return (
    <ol className="mg-game-scores mg-impostor-tasks" aria-label={fake ? '가짜 작업' : '내 작업'}>
      {view.tasks.map((task) => (
        <li key={task.station} data-done={task.done || undefined}>
          <span>{TASK_NAMES[view.stationKinds[task.station] ?? 'wires']}</span>
          {task.done ? (
            <b>완료</b>
          ) : (
            view.working?.station === task.station && (
              <b>
                <Seconds at={view.working.readyAt} serverNow={serverNow} />
              </b>
            )
          )}
        </li>
      ))}
    </ol>
  );
}

/** How the last meeting ended, and who voted for whom. */
function Verdict({ last, names }: { last: NonNullable<ImpostorView['lastMeeting']>; names: Names }) {
  const said = last.ejected ? `${last.name}님이 추방됐어요 · ${last.impostor ? '임포스터' : '크루'}였어요` : '아무도 추방되지 않았어요';
  const remaining = `임포스터 ${last.remaining}명 남음`;
  const tally = new Map<string | null, string[]>();
  for (const { voter, target } of last.votes) tally.set(target, [...(tally.get(target) ?? []), voter]);
  const rows = [...tally].sort((a, b) => b[1].length - a[1].length);
  return (
    <section className="mg-impostor-verdict" aria-label="지난 회의">
      <p>
        {said} <span className="mg-badge">{remaining}</span>
      </p>
      {rows.length > 0 && (
        <ul className="mg-impostor-tally">
          {rows.map(([target, voters]) => (
            <li key={target ?? ''}>
              <span>{target === null ? '건너뛰기' : (names.get(target) ?? '')}</span>
              <small>{voters.flatMap((voter) => names.get(voter) ?? []).join(', ')}</small>
              <b>{voters.length}표</b>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The meeting's lines (and, to the dead, the ghosts'), with a line to send when the viewer may talk. */
function Talk({ lines, you, act, label, open }: { lines: ImpostorLine[]; you: string; act: Act; label: string; open: boolean }) {
  const [text, setText] = useState('');
  const log = useRef<HTMLOListElement>(null);
  const last = lines.at(-1)?.id;
  useEffect(() => {
    const list = log.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [last]);
  const send = (event: FormEvent) => {
    event.preventDefault();
    const line = text.trim().slice(0, MAX_TEXT);
    if (line && act({ do: 'say', text: line })) setText('');
  };
  // Typing walks nobody on the island; Escape still folds the panel.
  const keep = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') event.stopPropagation();
  };
  return (
    <section className="mg-impostor-talk" aria-label={label}>
      {lines.length > 0 && (
        <ol ref={log} aria-live="polite">
          {lines.map((line) => (
            <li key={line.id} data-ghost={line.ghost || undefined} data-mine={line.from === you || undefined}>
              {line.ghost && <span className="mg-badge">유령</span>}
              <b>{line.name}</b>
              <span>{line.text}</span>
            </li>
          ))}
        </ol>
      )}
      {open && (
        <form onSubmit={send}>
          <input
            className="mg-field"
            value={text}
            maxLength={MAX_TEXT}
            placeholder="말하기"
            aria-label="말하기"
            enterKeyHint="send"
            autoComplete="off"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={keep}
          />
          <button type="submit" className="mg-btn is-small" disabled={!text.trim()}>
            보내기
          </button>
        </form>
      )}
    </section>
  );
}

/** Between meetings: role, the last verdict, the sabotage underway, progress and tasks; the dead also talk among themselves. */
function Roaming({ view, session, me, act, serverNow, names }: GameProps<ImpostorView> & { names: Names }) {
  const comms = view.progress === null;
  return (
    <div className="mg-game-hud mg-impostor">
      <Role view={view} names={names} you={session.you} />
      {view.lastMeeting && <Verdict last={view.lastMeeting} names={names} />}
      {view.sabotage && <p className="mg-impostor-broken">{SABOTAGE_NAMES[view.sabotage.kind]}</p>}
      {view.progress && <Progress {...view.progress} />}
      {view.role && !comms && <Tasks view={view} serverNow={serverNow} />}
      {me && view.alive === false && <Talk lines={view.talk} you={session.you} act={act} label="유령 대화" open />}
    </div>
  );
}

/** A meeting: who called it, the clock, everyone with a vote button (to vote, alive, once) and the talk. */
function Meeting({ view, session, me, act, serverNow, names, meeting }: GameProps<ImpostorView> & { names: Names; meeting: ImpostorMeeting }) {
  const left = useRemaining(meeting.endsAt, serverNow);
  const voting = meeting.stage === 'vote';
  const living = view.alive === true;
  const open = voting && living && !meeting.myVote;
  const head =
    meeting.reason === 'report' && meeting.body
      ? `${meeting.callerName}님이 ${meeting.body.name}님을 신고했어요`
      : `${meeting.callerName}님이 긴급 회의를 열었어요`;
  return (
    <div className="mg-game-hud mg-impostor">
      <Role view={view} names={names} you={session.you} />
      <p className="mg-impostor-head">{head}</p>
      <div className="mg-impostor-clock">
        <span className="mg-badge">{voting ? '투표' : '토론'}</span>
        <p className="mg-game-timer" role="timer" aria-label={voting ? '투표 남은 시간' : '토론 남은 시간'}>
          {clock(left)}
        </p>
        {voting && (
          <b className="mg-impostor-count">
            <span className="mg-sr">투표한 사람 </span>
            {meeting.voted}/{meeting.voters}
          </b>
        )}
      </div>
      <ul className="mg-game-players mg-impostor-seats" aria-label="투표">
        {view.players.map((player) => {
          const out = !player.alive;
          return (
            <li key={player.id} data-out={out || undefined} aria-current={player.id === session.you ? 'true' : undefined}>
              <span>{player.name}</span>
              {player.bot && <span className="mg-badge">봇</span>}
              {out && <span className="mg-badge">탈락</span>}
              {meeting.myVote?.target === player.id && <span className="mg-badge mg-impostor-mine">내 표</span>}
              {open && !out && (
                <button type="button" className="mg-btn is-small" aria-label={`${player.name} 투표`} onClick={() => act({ do: 'vote', target: player.id })}>
                  투표
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {living && voting && (
        <div className="mg-game-actions">
          <button type="button" className="mg-btn is-small" disabled={!open} onClick={() => act({ do: 'vote', target: null })}>
            건너뛰기
          </button>
          {meeting.myVote && meeting.myVote.target === null && <span className="mg-badge mg-impostor-mine">건너뛰었어요</span>}
        </div>
      )}
      <Talk lines={view.talk} you={session.you} act={act} label={view.alive === false ? '유령 대화' : '회의 대화'} open={!!me} />
    </div>
  );
}

/** While it plays: between meetings, or a meeting. */
export function ImpostorPanel(props: GameProps<ImpostorView>) {
  const { view } = props;
  const names: Names = new Map(view.players.map((player) => [player.id, player.name]));
  if (view.meeting && view.phase !== 'ended') return <Meeting {...props} names={names} meeting={view.meeting} />;
  return <Roaming {...props} names={names} />;
}

/** Once it has ended: the winning side and everyone's role. */
export function ImpostorResult({ result, session }: GameResultProps<ImpostorView, ImpostorOutcome>) {
  const mine = result.players.find((player) => player.id === session.you);
  return (
    <div className="mg-game-hud mg-impostor">
      <p className="mg-impostor-winner" role="status">
        {result.winner === 'crew' ? '크루가 이겼어요' : '임포스터가 이겼어요'}
        {mine && <span className="mg-badge mg-impostor-mine">{mine.role === result.winner ? '승리' : '패배'}</span>}
      </p>
      <p className="mg-muted">{REASON[result.reason]}</p>
      <ol className="mg-game-scores" aria-label="역할">
        {result.players.map((player) => (
          <li key={player.id} aria-current={player.id === session.you ? 'true' : undefined}>
            <span>{player.name}</span>
            {player.bot && <span className="mg-badge">봇</span>}
            {(player.left || !player.alive) && <i>{player.left ? '나감' : '탈락'}</i>}
            <RoleBadge role={player.role} />
          </li>
        ))}
      </ol>
    </div>
  );
}
