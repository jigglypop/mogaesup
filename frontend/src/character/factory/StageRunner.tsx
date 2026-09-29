import { useCallback, useEffect, useRef, useState } from 'react';
import { isDefinitiveRejection } from '../api';
import { usePolling } from '../use-polling';
import { factoryApi, type FactoryStage } from './api';

const labels: Record<FactoryStage, string> = {
  images: '이미지', models: '3D 파츠', rig: '리깅·동작', assemble: '피팅·조립', expressions: '기본 표정',
};
type Pending = { stage: FactoryStage; key: string };
function readPending(storage: string): Pending | null {
  try {
    const value = JSON.parse(localStorage.getItem(storage) || 'null');
    return value && Object.hasOwn(labels, value.stage) && typeof value.key === 'string' ? value : null;
  } catch { return null; }
}

export function StageRunner({ jobId, onChange }: { jobId: string; onChange: () => void }) {
  const storage = `gaesup.factory.stage:${jobId}`;
  const read = useCallback((signal: AbortSignal) => factoryApi.stages(jobId, signal), [jobId]);
  const polling = usePolling(read, value => value?.busy ? 3000 : 15000), state = polling.value;
  const [pending, setPending] = useState<Pending | null>(() => readPending(storage));
  const [sending, setSending] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function clearPending(intent: Pending) {
    if (readPending(storage)?.key === intent.key) localStorage.removeItem(storage);
  }
  async function start(stage: FactoryStage) {
    if (locked.current) return;
    const intent = readPending(storage) || pending || { stage, key: crypto.randomUUID() };
    locked.current = true; setSending(true); setError('');
    try {
      localStorage.setItem(storage, JSON.stringify(intent));
      setPending(intent);
      const result = await factoryApi.resumeStage(jobId, intent.stage, intent.key);
      clearPending(intent);
      if (alive.current) { setPending(null); polling.setValue(result); onChange(); }
    } catch (e) {
      // Only a definitive server rejection may discard the request identity.
      if (isDefinitiveRejection(e)) {
        clearPending(intent);
        if (alive.current) setPending(null);
      }
      if (alive.current) setError((e as Error).message);
    } finally { locked.current = false; if (alive.current) setSending(false); }
  }
  return <section className="stage-runner" aria-label="단계부터 실행">
    <div className="stage-runner-heading"><h2>단계부터 실행</h2>{state && <span>이미지 {state.saved.images}/{state.saved.images_total} · 3D {state.saved.models}/{state.saved.models_total} · 리깅 {state.saved.rig ? '저장됨' : '대기'}</span>}</div>
    <div className="stage-runner-actions">{state?.actions.map(action => <div key={action.stage}>
      <button disabled={sending || !!pending || !action.enabled} title={action.reason || undefined}
        data-recommended={state.recommended_stage === action.stage} onClick={() => void start(action.stage)}>
        {labels[action.stage]}부터 실행
      </button>
      <small>{action.reason || action.warning || (action.paid ? '미완료 유료 작업 포함' : '저장된 결과 재사용')}</small>
    </div>)}</div>
    {!state && !polling.error && <p role="status">저장된 단계 불러오는 중…</p>}
    {pending && <button disabled={sending} onClick={() => void start(pending.stage)}>{sending ? '접수 중…' : `${labels[pending.stage]} 실행 응답 복구`}</button>}
    {state?.busy && <p role="status">{labels[state.operation?.stage || state.recommended_stage || 'assemble']} 단계에서 이어서 실행 중…</p>}
    {(error || polling.error || state?.operation?.error) && <p role="alert">{error || polling.error || state?.operation?.error}</p>}
  </section>;
}
