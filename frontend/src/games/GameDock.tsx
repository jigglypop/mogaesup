import './games.css';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { Icon } from '../ui/icons';
import type { GameSession } from './protocol';
import { GAMES, gameOf } from './registry';
import { useActiveGame, useGameRoom, useGameState, type GameRoomValue } from './room';
import { openSpots } from './spots';
import { standing } from './teleport';

/** The host's layout for `session`'s game, from the island this page has loaded; throws when the game refuses. */
function layoutFor(room: GameRoomValue, session: GameSession): unknown {
  const definition = gameOf(session.kind);
  if (!definition) throw new Error('없는 게임이에요.');
  const building = room.building();
  return definition.layout({ building, spots: () => openSpots(building), position: standing(room.playerRef.current), session });
}

/**
 * The 게임 button and its panel: the games to open; a lobby's players with 참가·나가기 and the host's 시작·닫기; the game's
 * own panel while it plays; its result once it ends, with the host's 다시 하기·닫기. Shown while the viewer is in the
 * island's live room.
 */
export function GameDock() {
  const room = useGameRoom();
  const { session, connected, error } = useGameState();
  const active = useActiveGame();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState('');
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const focusPanel = useRef(false);
  const panelId = useId();
  const plays = !!session?.players.some((player) => player.id === session.you);
  const playing = session?.phase === 'playing' && plays;
  // A game the viewer plays brings its panel up as it starts, and again whenever it waits for an answer there.
  const attention = playing ? (gameOf(session?.kind)?.attention?.(session?.game) ?? null) : null;
  useEffect(() => {
    if (playing) setOpen(true);
  }, [playing]);
  useEffect(() => {
    if (attention) setOpen(true);
  }, [attention]);
  useEffect(() => {
    if (!open || !focusPanel.current) return;
    focusPanel.current = false;
    panel.current?.focus();
  }, [open]);
  useEffect(() => setProblem(''), [session?.phase, session?.kind]);
  if (!room?.live) return null;

  const { client } = room;
  const definition = gameOf(session?.kind);
  const count = session?.players.length ?? 0;
  const host = !!session && session.host === session.you;
  const fold = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    fold();
  };
  const start = () => {
    if (!session) return;
    setProblem('');
    try {
      client.start(layoutFor(room, session));
    } catch (cause) {
      setProblem(cause instanceof Error && cause.message ? cause.message : '시작하지 못했어요.');
    }
  };
  const said = error?.message ?? problem;

  let body;
  if (!connected) {
    body = (
      <p className="mg-muted" role="status">
        연결 중…
      </p>
    );
  } else if (!session) {
    body = (
      <ul className="mg-game-list" aria-label="게임">
        {GAMES.map((game) => (
          <li key={game.kind}>
            <button type="button" className="mg-btn is-wide" onClick={() => client.open(game.kind)}>
              {game.label}
            </button>
          </li>
        ))}
      </ul>
    );
  } else if (session.phase === 'lobby') {
    const minimum = definition?.minPlayers ?? 1;
    const full = count >= (definition?.maxPlayers ?? Infinity);
    body = (
      <>
        <ul className="mg-game-players" aria-label="참가한 사람">
          {session.players.map((player) => (
            <li key={player.id}>
              <span>{player.name}</span>
              {player.id === session.host && <span className="mg-badge">방장</span>}
            </li>
          ))}
        </ul>
        <div className="mg-game-actions">
          {plays ? (
            <button type="button" className="mg-btn is-small" onClick={client.leave}>
              나가기
            </button>
          ) : (
            <button type="button" className="mg-btn is-small is-primary" disabled={full} onClick={client.join}>
              참가
            </button>
          )}
          {host && (
            <button type="button" className="mg-btn is-small is-primary" disabled={count < minimum} onClick={start}>
              시작 {count < minimum ? `${count}/${minimum}` : `${count}명`}
            </button>
          )}
          {host && (
            <button type="button" className="mg-btn is-small is-quiet" onClick={client.close}>
              닫기
            </button>
          )}
        </div>
      </>
    );
  } else {
    const ended = session.phase === 'ended';
    const Panel = ended ? undefined : active?.definition.Panel;
    const Result = ended ? active?.definition.Result : undefined;
    body = (
      <>
        {active && Panel && <Panel {...active.props} />}
        {active && Result && <Result {...active.props} result={active.result} />}
        {plays && (
          <div className="mg-game-actions">
            {ended && host && (
              <button type="button" className="mg-btn is-small is-primary" onClick={() => client.open(session.kind)}>
                다시 하기
              </button>
            )}
            {(!ended || !host) && (
              <button type="button" className="mg-btn is-small" onClick={client.leave}>
                나가기
              </button>
            )}
            {host && (
              <button type="button" className="mg-btn is-small is-quiet" onClick={client.close}>
                닫기
              </button>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <button
        ref={toggle}
        type="button"
        className="mg-btn mg-game-toggle"
        aria-label={session ? `게임 ${count}명` : '게임'}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          focusPanel.current = !open;
          setOpen(!open);
        }}
      >
        <Icon name="game" />
        <span className="mg-game-toggle-label">게임</span>
        {session && <span className="mg-count">{count}</span>}
      </button>
      {open && (
        <section
          ref={panel}
          id={panelId}
          className="mg-game mg-glass"
          aria-label={definition?.label ?? '게임'}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          <header className="mg-game-head">
            <h2>{session ? (definition?.label ?? session.kind) : '게임'}</h2>
            <button type="button" className="mg-icon-btn is-quiet" aria-label="게임 접기" onClick={fold}>
              <Icon name="close" />
            </button>
          </header>
          {body}
          {said && (
            <p className="mg-error" role="alert">
              {said}
            </p>
          )}
        </section>
      )}
    </>
  );
}
