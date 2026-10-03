import { useEffect, useRef, useState } from 'react';
import { PendingRequestConflict, type Pending } from '../api';
import { factoryApi, type GarmentShape, type WardrobePart } from '../factory/api';
import { pollUntil } from './poll-until';

const FITS: { value: NonNullable<GarmentShape['fit']>; label: string }[] = [
  { value: 'tight', label: '붙음' }, { value: 'normal', label: '보통' }, { value: 'loose', label: '넓음' }];
const HEM_RANGE: Record<string, string> = { top: '허리~가랑이', bottom: '반바지~발목' };
const sleeveText = (value: number) => value <= 0 ? '없음' : value >= 1 ? '손목' : `${Math.round(value*100)}%`;
const initialShape = (part: WardrobePart): GarmentShape => ({
  ...(part.slot === 'top' ? { sleeve: part.shape?.sleeve ?? .5 } : {}), hem: part.shape?.hem ?? .5, fit: part.shape?.fit ?? 'normal' });
const POLL_MS = 2000;

/** Sleeve, hem and fit of a worn body-shell top or bottom. Rebuilding refits the part in its own job;
 * `replace` receives the new version once the wardrobe lists it. Closing the panel stops the waiting. */
export function WardrobeShape({ part, label, reload, replace }: {
  part: WardrobePart; label: string;
  reload: (signal?: AbortSignal) => Promise<WardrobePart[]>; replace: (next: WardrobePart) => void;
}) {
  const [draft, setDraft] = useState<GarmentShape>(() => initialShape(part));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [elapsed, setElapsed] = useState(0);
  // A saved refit of this job that is not this rebuild (an answer lost for another shape or screen): it is resumed or
  // cleared here, never sent in this one's place.
  const [saved, setSaved] = useState<Pending<unknown> | null>(null);
  const closed = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    closed.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => { setDraft(initialShape(part)); }, [part.job_id, part.version]);

  async function rebuild(send: () => Promise<unknown>) {
    const signal = closed.current?.signal;
    if (!signal || signal.aborted) return;
    setBusy(true); setError(''); setSaved(null); setElapsed(0);
    const started = performance.now();
    const tick = setInterval(() => setElapsed(Math.round((performance.now() - started)/1000)), 1000);
    try {
      await send();
      const rebuilt = await pollUntil(
        stop => factoryApi.nativeParts(part.job_id, stop),
        state => {
          if (['failed', 'recovery_required', 'qc_failed'].includes(state.status)) throw new Error(state.error || '다시 만들지 못했습니다.');
          return state.status === 'review_required' && state.version && state.version !== part.version ? state.version : undefined;
        }, { attempts: 151, delayMs: POLL_MS, signal });
      if (signal.aborted) return;
      if (!rebuilt) throw new Error('다시 만들기가 끝나지 않았습니다.');
      // The job listing behind the wardrobe refreshes every few seconds.
      const next = await pollUntil(
        stop => reload(stop),
        parts => parts.find(item => item.job_id === part.job_id && item.slot === part.slot && item.version !== part.version),
        { attempts: 15, delayMs: POLL_MS, immediate: true, signal });
      if (signal.aborted) return;
      if (!next) throw new Error('새 버전이 옷장에 아직 보이지 않습니다.');
      replace(next);
    } catch (reason) {
      if (signal.aborted) return;
      setError((reason as Error).message);
      if (reason instanceof PendingRequestConflict) setSaved(reason.pending);
    } finally { clearInterval(tick); if (!signal.aborted) setBusy(false); }
  }
  function clearSaved(key: string) {
    try { factoryApi.acknowledgeRefit(part.job_id, key); setSaved(null); setError(''); }
    catch (reason) { setError((reason as Error).message); }
  }

  return <li className="wardrobe-shape">
    <span>{label}</span>
    <div className="wardrobe-shape-controls">
      {part.slot === 'top' && <label>소매
        <input type="range" min={0} max={1} step={.05} value={draft.sleeve ?? .5} disabled={busy}
          onChange={event => { const sleeve = Number(event.target.value); setDraft(current => ({ ...current, sleeve })); }} />
        <output>{sleeveText(draft.sleeve ?? .5)}</output></label>}
      <label>밑단 {HEM_RANGE[part.slot]}
        <input type="range" min={0} max={1} step={.05} value={draft.hem ?? .5} disabled={busy}
          onChange={event => { const hem = Number(event.target.value); setDraft(current => ({ ...current, hem })); }} />
        <output>{Math.round((draft.hem ?? .5)*100)}%</output></label>
      <div className="wardrobe-shape-fit" role="group" aria-label={`${label} 품`}>{FITS.map(fit =>
        <button key={fit.value} type="button" aria-pressed={draft.fit === fit.value} disabled={busy}
          onClick={() => setDraft(current => ({ ...current, fit: fit.value }))}>{fit.label}</button>)}</div>
    </div>
    <div className="wardrobe-shape-actions">
      <button type="button" disabled={busy} onClick={() => void rebuild(() => factoryApi.refitPart(part.job_id, part.version, part.slot, undefined, 'body_shell', draft))}>{busy ? `다시 만드는 중 ${elapsed}초` : '다시 만들기'}</button>
      {part.shape && <button type="button" disabled={busy} onClick={() => void rebuild(() => factoryApi.refitPart(part.job_id, part.version, part.slot, undefined, 'body_shell', {}))}>그림대로</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {saved && <div className="wardrobe-shape-actions">
      <button type="button" disabled={busy} onClick={() => void rebuild(() => factoryApi.resumeRefit(part.job_id))}>저장된 요청 이어서 보내기</button>
      <button type="button" disabled={busy} onClick={() => clearSaved(saved.key)}>저장된 요청 지우기</button>
    </div>}
  </li>;
}
