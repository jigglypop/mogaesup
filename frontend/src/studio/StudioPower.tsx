import './power.css';

import { useCallback, useEffect, useRef, useState } from 'react';

import { problemText } from '../api/client';
import { catalogApi } from '../api/endpoints';
import { WAKE_RETRY_MS, probeStudio, type StudioSleep } from '../api/studioSleep';
import type { StudioPower } from '../api/types';

/** Runs `run` every `ms` while `ms` is set. */
export function useEvery(ms: number | null, run: () => unknown) {
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });
  useEffect(() => {
    if (ms === null) return undefined;
    const timer = window.setInterval(() => void latest.current(), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
}

function useElapsed(since: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The studio starting (or still shutting down), with how long it has been. */
export function WakeBanner({ sleep, text, inline = false }: { sleep: StudioSleep; text?: string; inline?: boolean }) {
  const elapsed = useElapsed(sleep.since);
  return (
    <div
      className={`mg-wake mg-glass${sleep.code === 'studio_stopping' ? ' is-stopping' : ''}${inline ? ' is-inline' : ''}`}
      role="status"
    >
      <b>{text ?? sleep.message}</b>
      <span className="mg-wake-bar" aria-hidden="true">
        <i />
      </span>
      <small>{elapsed}</small>
    </div>
  );
}

/** In place of the studio's screens while it sleeps; asks again every 10 s and the screens return once it answers. */
export function StudioWaking({ sleep, member }: { sleep: StudioSleep; member: boolean }) {
  useEvery(WAKE_RETRY_MS, probeStudio);
  const text = !member
    ? sleep.message
    : sleep.code === 'studio_stopping'
      ? '옷장이 잠시 쉬는 중이에요. 곧 다시 열어요.'
      : '옷장을 여는 중이에요. 1~2분 걸려요.';
  return <WakeBanner sleep={sleep} text={text} />;
}

const STATE_LABEL: Record<string, string> = {
  running: '스튜디오 켜짐',
  pending: '스튜디오 켜는 중',
  stopping: '스튜디오 꺼지는 중',
  stopped: '스튜디오 꺼짐',
};

/**
 * For admins: the studio instance's power, and a start button while it is stopped. Asked again every 10 s until it runs;
 * nothing when this server does not manage the instance (local runs), nor while it runs when `quietWhenRunning`.
 */
export function StudioPowerLine({ quietWhenRunning = false, onRunning }: { quietWhenRunning?: boolean; onRunning?: () => void }) {
  const [power, setPower] = useState<StudioPower | null>(null);
  const [problem, setProblem] = useState('');
  const [starting, setStarting] = useState(false);
  const running = useRef(onRunning);
  useEffect(() => {
    running.current = onRunning;
  });
  const last = useRef<StudioPower | null>(null);
  const apply = useCallback((next: StudioPower) => {
    const previous = last.current;
    last.current = next;
    setPower(next);
    setProblem('');
    if (next.configured && next.state === 'running' && previous?.configured && previous.state !== 'running') running.current?.();
  }, []);
  const read = useCallback(
    () => catalogApi.studioPower().then(apply, (reason: unknown) => setProblem(problemText(reason))),
    [apply],
  );
  useEffect(() => {
    void read();
  }, [read]);
  const settled = power !== null && (!power.configured || power.state === 'running');
  useEvery(settled ? null : WAKE_RETRY_MS, read);

  if (!power?.configured || (quietWhenRunning && power.state === 'running' && !problem)) return null;
  const start = async () => {
    setStarting(true);
    try {
      apply(await catalogApi.startStudio());
    } catch (reason) {
      setProblem(problemText(reason));
    } finally {
      setStarting(false);
    }
  };
  const moving = power.state === 'pending' || power.state === 'stopping';
  return (
    <div className="mg-studio-power" role="status">
      <p>
        <i className={`mg-dot${power.state === 'running' ? ' is-good' : ''}`} />
        {STATE_LABEL[power.state] ?? power.state}
      </p>
      {moving && (
        <span className="mg-wake-bar" aria-hidden="true">
          <i />
        </span>
      )}
      {power.state === 'stopped' && (
        <button type="button" className="mg-btn is-small" disabled={starting} onClick={() => void start()}>
          {starting ? '켜는 중' : '스튜디오 켜기'}
        </button>
      )}
      {problem && <small className="mg-error">{problem}</small>}
    </div>
  );
}
