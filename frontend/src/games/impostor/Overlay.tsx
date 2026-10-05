import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import type { GameProps } from '../game';
import { clock, useRemaining } from '../time';
import type { ImpostorEvent, ImpostorView, SabotageKind } from './index';
import { TASK_NAMES, TaskGame } from './tasks';


export const SABOTAGE_NAMES: Record<SabotageKind, string> = { lights: '정전', comms: '통신 방해', reactor: '원자로' };
const SABOTAGES: SabotageKind[] = ['lights', 'comms', 'reactor'];
/** How long a splash stays up. */
const SPLASH = 2_600;

const seconds = (ms: number) => Math.ceil(ms / 1000);

/** A big line over the island for a moment. */
type Splash = { key: number; text: string; detail?: string; tone: 'crew' | 'impostor' | 'alarm' };

function useSplash(): [Splash | null, (splash: Omit<Splash, 'key'>, ms?: number) => void] {
  const [splash, setSplash] = useState<Splash | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback((next: Omit<Splash, 'key'>, ms = SPLASH) => {
    clearTimeout(timer.current);
    setSplash({ ...next, key: Date.now() });
    timer.current = setTimeout(() => setSplash(null), ms);
  }, []);
  return [splash, show];
}

/** The task underway, played here; its finish goes to the server once solved and its time has passed. */
function TaskScreen({ view, act, serverNow }: Pick<GameProps<ImpostorView>, 'view' | 'act' | 'serverNow'>) {
  const working = view.working!;
  const [solved, setSolved] = useState(false);
  const left = useRemaining(working.readyAt, serverNow, 100);
  const sent = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  useEffect(() => {
    if (!solved || left > 0 || sent.current) return;
    sent.current = true;
    act({ do: 'finish' });
  }, [solved, left, act]);
  // The keys work the task, not the island; Escape puts it down.
  const keys = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'Escape') act({ do: 'stop' });
  };
  return (
    <div ref={box} className="mg-impostor-task mg-glass" role="dialog" aria-modal="true" aria-label={TASK_NAMES[working.kind]} tabIndex={-1} onKeyDown={keys}>
      <header className="mg-game-head">
        <h2>{TASK_NAMES[working.kind]}</h2>
        <button type="button" className="mg-icon-btn is-quiet" aria-label="작업 그만두기" onClick={() => act({ do: 'stop' })}>
          ✕
        </button>
      </header>
      <TaskGame kind={working.kind} readyAt={working.readyAt} serverNow={serverNow} onDone={() => setSolved(true)} />
      {solved && <p className="mg-impostor-solved" role="status">완료</p>}
    </div>
  );
}

/** What is broken, and for the reactor how long is left; 고치기 at its panel. */
function Alarm({ view, act, serverNow }: Pick<GameProps<ImpostorView>, 'view' | 'act' | 'serverNow'>) {
  const sabotage = view.sabotage!;
  const left = useRemaining(sabotage.endsAt ?? 0, serverNow);
  const fixing = view.alive === true && view.venting === null && view.near.panel;
  return (
    <div className="mg-impostor-alarm mg-glass" role="alert" data-kind={sabotage.kind}>
      <b>{SABOTAGE_NAMES[sabotage.kind]}</b>
      {sabotage.endsAt !== null && <span className="mg-game-timer">{clock(left)}</span>}
      {sabotage.kind === 'reactor' && (
        <span className="mg-impostor-held">
          {sabotage.held.map((held, index) => (
            <i key={index} data-held={held || undefined} aria-label={held ? '잡음' : '비어 있음'} />
          ))}
        </span>
      )}
      {fixing && (
        <button type="button" className="mg-btn is-small is-primary" onClick={() => act({ do: 'fix' })}>
          고치기
        </button>
      )}
    </div>
  );
}

/** The viewer's buttons in reach, as Among Us puts them in a corner: 작업, 신고, 긴급 회의, 처치, 환풍구, sabotage. */
function Actions({ view, act, serverNow }: Pick<GameProps<ImpostorView>, 'view' | 'act' | 'serverNow'>) {
  const kill = useRemaining(view.kill?.readyAt ?? 0, serverNow);
  const sabotageWait = useRemaining(view.sabotageFrom ?? 0, serverNow);
  const emergencyWait = useRemaining(view.emergencyFrom, serverNow);
  const names = new Map(view.players.map((player) => [player.id, player.name]));
  const living = view.alive === true;
  const venting = view.venting;
  const out = venting === null;
  const impostor = view.role === 'impostor';
  const target = view.kill?.targets[0];
  return (
    <div className="mg-impostor-actions" role="group" aria-label="행동">
      {venting !== null && (
        <div className="mg-impostor-vents" role="group" aria-label="환풍구">
          {view.vents.map((_, index) =>
            index === venting ? null : (
              <button key={index} type="button" className="mg-btn is-small" onClick={() => act({ do: 'vent', to: index })}>
                환풍구 {index + 1}
              </button>
            ),
          )}
          <button type="button" className="mg-btn is-small is-primary" onClick={() => act({ do: 'vent' })}>
            나가기
          </button>
        </div>
      )}
      {view.role === 'crew' && (
        <button type="button" className="mg-btn is-primary" disabled={!!view.working || view.near.station === null} onClick={() => act({ do: 'task' })}>
          작업
        </button>
      )}
      {impostor && living && out && (
        <button type="button" className="mg-btn is-danger" disabled={kill > 0 || !target} onClick={() => target && act({ do: 'kill', target })}>
          {kill > 0 ? `처치 ${seconds(kill)}` : target ? `처치 · ${names.get(target) ?? ''}` : '처치'}
        </button>
      )}
      {impostor && living && out && (
        <button type="button" className="mg-btn" disabled={view.near.vent === null} onClick={() => act({ do: 'vent' })}>
          환풍구
        </button>
      )}
      {living && out && (
        <button type="button" className="mg-btn" disabled={view.near.body === null} onClick={() => view.near.body !== null && act({ do: 'report', body: view.near.body })}>
          신고
        </button>
      )}
      {living && out && view.emergencyLeft > 0 && (
        <button
          type="button"
          className="mg-btn"
          disabled={!view.near.table || emergencyWait > 0 || !!view.sabotage}
          onClick={() => act({ do: 'meeting' })}
        >
          {emergencyWait > 0 ? `긴급 회의 ${seconds(emergencyWait)}` : '긴급 회의'}
        </button>
      )}
      {impostor && (
        <div className="mg-impostor-sabotage" role="group" aria-label={sabotageWait > 0 ? `사보타주 ${seconds(sabotageWait)}초` : '사보타주'}>
          {SABOTAGES.map((kind) => (
            <button key={kind} type="button" className="mg-btn is-small" disabled={sabotageWait > 0 || !!view.sabotage} onClick={() => act({ do: 'sabotage', kind })}>
              {SABOTAGE_NAMES[kind]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Over the whole page while 임포스터 plays: the side dealt at the start, splashes for a kill, a meeting and a verdict,
 * the dark of a lights-out for the crew, the sabotage alarm, the task being played, and the buttons in reach.
 */
export function ImpostorOverlay({ view, me, act, onEvent, serverNow }: GameProps<ImpostorView>) {
  const [splash, show] = useSplash();
  const names = useRef(new Map<string, string>());
  names.current = new Map(view.players.map((player) => [player.id, player.name]));
  const role = view.role;
  useEffect(() => {
    if (!role) return;
    const partners = (view.impostors ?? []).flatMap((id) => (id === me?.id ? [] : (names.current.get(id) ?? [])));
    show(
      role === 'crew'
        ? { text: '크루', tone: 'crew' }
        : { text: '임포스터', detail: partners.length ? `동료 ${partners.join(', ')}` : undefined, tone: 'impostor' },
      3_200,
    );
    // Once, as the game starts: the overlay mounts with it.
  }, []);
  useEffect(
    () =>
      onEvent((raw) => {
        const event = raw as ImpostorEvent;
        if (event.type === 'killed') show({ text: '처치당했어요', tone: 'alarm' });
        if (event.type === 'meeting') {
          const caller = names.current.get(event.caller) ?? '';
          show({ text: event.reason === 'report' ? '시체 발견' : '긴급 회의', detail: caller, tone: 'alarm' });
        }
        if (event.type === 'verdict') {
          const text = event.ejected
            ? `${event.name}님은 ${event.impostor ? '임포스터였어요' : '임포스터가 아니었어요'}`
            : '아무도 추방되지 않았어요';
          show({ text, tone: event.impostor ? 'crew' : 'impostor' }, 3_400);
        }
        if (event.type === 'sabotage') show({ text: SABOTAGE_NAMES[event.kind], tone: 'alarm' }, 1_600);
      }),
    [onEvent, show],
  );
  const playing = view.phase === 'play';
  const dark = playing && view.sabotage?.kind === 'lights' && view.role === 'crew' && view.alive === true;
  return (
    <>
      {dark && <div className="mg-impostor-dark" aria-hidden="true" />}
      {playing && view.sabotage && <Alarm view={view} act={act} serverNow={serverNow} />}
      {playing && me && view.working && view.role === 'crew' && (
        <TaskScreen key={`${view.working.station}-${view.working.readyAt}`} view={view} act={act} serverNow={serverNow} />
      )}
      {playing && me && view.role && <Actions view={view} act={act} serverNow={serverNow} />}
      {splash && (
        <div key={splash.key} className="mg-impostor-splash" data-tone={splash.tone} role="status">
          <b>{splash.text}</b>
          {splash.detail && <span>{splash.detail}</span>}
        </div>
      )}
    </>
  );
}
