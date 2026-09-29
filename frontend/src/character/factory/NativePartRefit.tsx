import { useEffect, useRef, useState } from 'react';
import { factoryApi, type LimbFitCheck, type NativePartsState } from './api';
import { partLabels } from './parts';

/** Measured sleeve / trouser-leg clearance of a worn part, or what failed. */
function LimbFit({ slot, check }: { slot: string; check?: LimbFitCheck }) {
  const limbs = Object.values(check?.limbs || {}).filter(limb => limb.rings);
  if (!check || !limbs.length || (check.status !== 'pass' && check.status !== 'fail')) return null;
  if (check.status === 'fail') return <small className="limb-fit" role="status">{check.failures.map(item => item.message).join(' · ')}</small>;
  const margin = Math.min(...limbs.map(limb => limb.min_margin_cm ?? 0));
  const angles = limbs.map(limb => limb.angle_deg).filter((angle): angle is number => typeof angle === 'number');
  return <small className="limb-fit">{slot === 'top' ? '소매' : '다리'} 여유 최소 {margin >= 0 ? '+' : ''}{margin.toFixed(1)}cm
    {angles.length ? ` · 각도 최대 ${Math.max(...angles).toFixed(1)}°` : ''}</small>;
}

export function NativePartRefit({ jobId, state, slot, disabled = false, onChange }: {
  jobId: string; state?: NativePartsState; slot?: string; disabled?: boolean;
  onChange: (value: NativePartsState) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submitting = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, [jobId]);
  let pending: ReturnType<typeof factoryApi.pendingRefit> = null, recoveryError = '';
  try { pending = factoryApi.pendingRefit(jobId); }
  catch (reason) { recoveryError = (reason as Error).message; }
  if (pending?.key === state?.refit_request_key) pending = null;
  useEffect(() => {
    if (!state?.refit_request_key) return;
    try { factoryApi.acknowledgeRefit(jobId, state.refit_request_key); }
    catch (reason) { setError((reason as Error).message); }
  }, [jobId, state?.refit_request_key]);
  async function refit(selected: string, method?: 'isolated' | 'body_shell') {
    const version = pending?.input.source_version || state?.version;
    if (submitting.current || !version) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const value = await factoryApi.refitPart(jobId, version, selected, undefined, method);
      if (alive.current) onChange(value);
    } catch (reason) { if (alive.current) setError((reason as Error).message); }
    finally { submitting.current = false; if (alive.current) setBusy(false); }
  }
  async function resume() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const value = await factoryApi.assemble(jobId);
      if (alive.current) onChange(value);
    } catch (reason) { if (alive.current) setError((reason as Error).message); }
    finally { submitting.current = false; if (alive.current) setBusy(false); }
  }
  const available = state?.status === 'review_required' && state.version && !state.preview && state.origin !== 'uploaded_glb';
  const working = !!state?.preview && (['accepted', 'running'].includes(state.status) || state.expression_pending);
  const resumable = !!state?.preview && !!state.refit_request_key && ['failed', 'recovery_required', 'qc_failed'].includes(state.status);
  const parts = available ? state.parts.filter(part => part.slot !== 'body' && (!slot || part.slot === slot)) : [];
  if (!pending && !parts.length && !working && !resumable && !error && !recoveryError && !state?.error) return null;
  return <div className="native-part-refit">
    <div className="meshy-buttons">{parts.map(part => <span key={part.slot}>
      {part.fit_method !== 'body-shell-v1' && <button disabled={busy || disabled || !!pending || !!recoveryError} onClick={() => void refit(part.slot)}>
        {part.slot === 'hair' ? '헤어 후면 보완·최적화' : `${partLabels[part.slot] || part.slot} 다시 맞추기·최적화`}
      </button>}
      {(part.slot === 'top' || part.slot === 'bottom') && <button disabled={busy || disabled || !!pending || !!recoveryError} onClick={() => void refit(part.slot, 'body_shell')}>
        {`${partLabels[part.slot]} 몸에 맞춰 다시 만들기`}
      </button>}
      <LimbFit slot={part.slot} check={part.limb_fit?.check} />
    </span>)}
    {pending && <button disabled={busy || !!recoveryError} onClick={() => void refit(pending!.input.slot, pending!.input.part_method)}>같은 피팅 요청 복구</button>}</div>
    {resumable && !pending && <button disabled={busy || disabled} onClick={() => void resume()}>피팅·최적화 이어가기</button>}
    {(busy || working) && <p role="status">{busy ? '처리 요청 중…' : '파츠 피팅·저장 중…'}</p>}
    {(error || recoveryError) && <p role="alert">{error || recoveryError}</p>}
    {state?.preview && state.error && <p role="alert">{state.error}</p>}
  </div>;
}
