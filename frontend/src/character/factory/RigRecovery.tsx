import { useCallback, useEffect, useRef, useState } from 'react';
import { isDefinitiveRejection } from '../api';
import { usePolling } from '../use-polling';
import { useSavedRequests } from '../use-saved-requests';
import { factoryApi, type RigTransferInput, type RigTransferSource } from './api';
import './meshy-motion.css';

type Pending = { key: string; input: RigTransferInput };

function readPending(storage: string): { pending: Pending | null; error: string } {
  try {
    const raw = localStorage.getItem(storage);
    if (!raw) return { pending: null, error: '' };
    const pending = JSON.parse(raw) as Pending;
    if (!pending || typeof pending.key !== 'string' || !pending.key
      || typeof pending.input?.source_job_id !== 'string' || !pending.input.source_job_id
      || typeof pending.input?.source_version !== 'string' || !pending.input.source_version) throw new Error();
    return { pending, error: '' };
  } catch {
    return { pending: null, error: '저장된 골격 복구 요청을 읽을 수 없습니다.' };
  }
}

/** How often a transfer under way is asked about. */
export const RIG_TRANSFER_POLL_MS = 5000;
const underWay = (status?: string) => status === 'accepted' || status === 'running';

type Props = { jobId: string; onComplete?: () => void; refreshKey?: string };

/**
 * Recovering a body's rig from a saved one. It asks every 5 s only while a transfer is under way and the tab is in view;
 * otherwise it reads again when the job it belongs to changes (`refreshKey`), the tab comes back or the connection does.
 * Another job starts afresh: no skeleton chosen or completion told for the last one carries over.
 */
export function RigRecovery(props: Props) {
  return <JobRigRecovery key={props.jobId} {...props} />;
}

function JobRigRecovery({ jobId, onComplete, refreshKey }: Props) {
  const storage = `gaesup.rig-transfer:${jobId}`;
  // Renders again when another tab saves or settles the request; the click reads storage again too.
  useSavedRequests();
  const [, rerender] = useState(0);
  const read = useCallback((signal: AbortSignal) => factoryApi.rigTransfer(jobId, signal), [jobId]);
  const polling = usePolling(read, value => underWay(value?.status) ? RIG_TRANSFER_POLL_MS : null), state = polling.value;
  const seenKey = useRef(refreshKey);
  useEffect(() => {
    if (seenKey.current === refreshKey) return;
    seenKey.current = refreshKey; void polling.refresh();
  }, [refreshKey, polling.refresh]);
  const recovered = readPending(storage), pending = recovered.pending;
  const recommendedKey = state?.recommended_source
    ? `${state.recommended_source.job_id}:${state.recommended_source.version}`
    : '';
  const [sources, setSources] = useState<RigTransferSource[]>(), [sourceError, setSourceError] = useState('');
  const [selected, setSelected] = useState(() => pending ? `${pending.input.source_job_id}:${pending.input.source_version}` : '');
  const [busy, setBusy] = useState(false), [submitError, setSubmitError] = useState('');
  const loadingSources = useRef(false), sourceRequest = useRef<AbortController | undefined>(undefined), submitted = useRef(false), notified = useRef(false);

  const loadSources = useCallback(async () => {
    if (loadingSources.current) return;
    loadingSources.current = true; setSourceError('');
    const controller = new AbortController(); sourceRequest.current = controller;
    try {
      const result = await factoryApi.rigTransferSources(controller.signal);
      setSources(result.items);
      setSelected(current => current || (recommendedKey && result.items.some(item => `${item.job_id}:${item.version}` === recommendedKey)
        ? recommendedKey
        : result.items[0] ? `${result.items[0].job_id}:${result.items[0].version}` : ''));
    } catch (error) { if (!controller.signal.aborted) setSourceError((error as Error).message); }
    finally { if (sourceRequest.current === controller) { sourceRequest.current = undefined; loadingSources.current = false; } }
  }, [recommendedKey]);

  useEffect(() => () => sourceRequest.current?.abort(), []);
  useEffect(() => { if (state?.can_start && sources === undefined && !sourceError) void loadSources(); }, [state?.can_start, sources, sourceError, loadSources]);
  useEffect(() => {
    if (!state) return;
    const current = readPending(storage).pending;
    if (current && state.request_key === current.key && ['running', 'paused', 'complete'].includes(state.status)) localStorage.removeItem(storage);
    if (state.status === 'complete' && !notified.current) { notified.current = true; onComplete?.(); }
  }, [state?.status, state?.id, state?.request_key, storage, onComplete]);

  /** Forgets the saved request only while it is still the one under `key` (another tab may have saved another). */
  function settle(key: string) { if (readPending(storage).pending?.key === key) localStorage.removeItem(storage); }
  async function start() {
    if (submitted.current || recovered.error) return;
    const saved = readPending(storage);
    // Another request saved since this one was drawn (another tab) is shown first, never sent in place of the one shown.
    if (saved.error || (pending && saved.pending && saved.pending.key !== pending.key)) { rerender(count => count + 1); void polling.refresh(); return; }
    // A recovery sends the request it showed under its key, even when another tab has had its answer and forgotten it
    // since: the server answers with what that key started. A request another tab saved since this one was drawn is sent
    // under its own key, never written over by a new one.
    const selectedSource = sources?.find(item => `${item.job_id}:${item.version}` === selected);
    const request = saved.pending || pending || (selectedSource ? { key: crypto.randomUUID(), input: { source_job_id: selectedSource.job_id, source_version: selectedSource.version } } : null);
    if (!request) return;
    submitted.current = true; setBusy(true); setSubmitError('');
    try {
      localStorage.setItem(storage, JSON.stringify(request));
      const result = await factoryApi.startRigTransfer(jobId, request.input, request.key);
      polling.setValue(result);
      if (result.request_key === request.key && ['running', 'paused', 'complete'].includes(result.status)) settle(request.key);
    } catch (error) {
      if (isDefinitiveRejection(error)) settle(request.key);
      setSubmitError((error as Error).message);
    } finally { submitted.current = false; setBusy(false); }
  }

  if (!state) {
    return polling.error ? <section className="rig-recovery"><p role="alert">{polling.error}</p><button onClick={() => void polling.refresh()}>복구 상태 다시 확인</button></section> : null;
  }
  if (!state.can_start && !pending && !underWay(state.status) && state.status !== 'paused') return null;
  const source = pending ? `${pending.input.source_job_id}:${pending.input.source_version}` : selected;
  const usingRecommended = !!recommendedKey && source === recommendedKey;
  const status = state.status === 'accepted' ? '복구 대기' : state.status === 'running' ? '골격·동작 이전 중' : state.status === 'paused' ? '복구 중단' : '';
  // The assembly after a recovery makes the default expressions, which is paid work; a server that does not say is paid.
  const cost = state.paid === false ? '' : ' · 유료 작업 포함';
  return <section className="rig-recovery" aria-label="저장된 골격 복구">
    <h3>저장된 골격으로 리깅 복구</h3>
    {state.can_start && !pending && <label>복구할 골격<select value={source} disabled={busy || !sources?.length} onChange={event => setSelected(event.target.value)}>{sources?.map(item => {
      const key = `${item.job_id}:${item.version}`;
      return <option key={key} value={key}>{item.name} · {item.job_id.slice(0, 8)}{key === recommendedKey ? ' · 권장' : ''}</option>;
    })}</select></label>}
    {pending && <p>{pending.input.source_job_id.slice(0, 8)} · 저장된 요청</p>}
    {(state.can_start || pending) && <button disabled={busy || !!recovered.error || (!pending && !sources?.length)} onClick={() => void start()}>{busy ? '복구 접수 중…' : pending && state.status === 'accepted' ? '접수된 복구 이어가기' : pending ? '저장된 골격 복구 결과 확인' : usingRecommended ? `권장 골격으로 복구${cost}` : `선택한 골격으로 복구${cost}`}</button>}
    {state.status !== 'not_started' && <p role="status">{status}{state.source_job_id ? ` · ${state.source_job_id}` : ''}</p>}
    {sources === undefined && state.can_start && !sourceError && <p role="status">저장된 골격 불러오는 중…</p>}
    {sources?.length === 0 && state.can_start && <p>재사용할 저장 골격이 없습니다.</p>}
    {sourceError && <p role="alert">{sourceError} <button onClick={() => { setSources(undefined); setSourceError(''); void loadSources(); }}>목록 다시 불러오기</button></p>}
    {(recovered.error || submitError || polling.error || state.error) && <p role="alert">{recovered.error || submitError || polling.error || state.error}{polling.error && <> <button onClick={() => void polling.refresh()}>복구 상태 다시 확인</button></>}</p>}
  </section>;
}
