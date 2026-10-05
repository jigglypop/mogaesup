import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { can } from '../../auth/can';
import { isDefinitiveRejection } from '../api';
import { factoryApi, type NativePartsState } from './api';

type ReviewInput = Parameters<typeof factoryApi.reviewNative>[2];
type PendingReview = { key: string; input: ReviewInput };
const decisionLabels: Record<ReviewInput['decision'], string> = { approved: '시각 승인', changes_requested: '수정 필요' };
/** The review sent for this version whose answer was lost; `unreadable` when what is kept for it cannot be read. */
function pendingReview(storage: string): { pending: PendingReview | null; unreadable: boolean } {
  try {
    // An older version kept it for the tab's session only.
    const legacy = sessionStorage.getItem(storage);
    if (legacy !== null) { if (!localStorage.getItem(storage)) localStorage.setItem(storage, legacy); sessionStorage.removeItem(storage); }
    const raw = localStorage.getItem(storage);
    if (!raw) return { pending: null, unreadable: false };
    const value = JSON.parse(raw) as PendingReview;
    if (!value?.key || typeof value.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.input?.expected_assembly_sha256 || '') || !['approved', 'changes_requested'].includes(value.input.decision)
      || typeof value.input.notes !== 'string' || typeof value.input.appearance_checked !== 'boolean' || typeof value.input.motion_checked !== 'boolean') throw new Error();
    return { pending: value, unreadable: false };
  } catch { return { pending: null, unreadable: true }; }
}

export function NativeReview({ jobId, state, onChange }: { jobId: string; state: NativePartsState; onChange(value: NativePartsState): void }) {
  const { user } = useAuth();
  const version = state.version!, storage = `gaesup.native-review:${jobId}:${version}`;
  const [notes, setNotes] = useState(''), [appearance, setAppearance] = useState(false), [motion, setMotion] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [pending, setPending] = useState<PendingReview | null>(null);
  const [unreadable, setUnreadable] = useState(false), [again, setAgain] = useState(false);
  const locked = useRef(false), alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const saved = pendingReview(storage);
    setPending(saved.pending); setUnreadable(saved.unreadable);
    if (saved.pending) { setNotes(saved.pending.input.notes); setAppearance(saved.pending.input.appearance_checked); setMotion(saved.pending.input.motion_checked); }
    return () => { alive.current = false; };
  }, [storage]);
  if (!can(user, 'operator')) return null;
  const sha = state.assembly_sha256 || state.artifacts.find(item => item.name === 'model.glb')?.sha256;
  if (!sha || !/^[a-f0-9]{64}$/.test(sha)) return null;
  // This model already has a decision on record: the form opens again only when asked to.
  const recorded = state.review?.assembly_sha256 === sha && (state.review.status === 'approved' || state.review.status === 'changes_requested') ? state.review.status : undefined;
  const validNotes = notes.trim().length >= 5 && notes.trim().length <= 2000;
  async function submit(decision: ReviewInput['decision']) {
    if (locked.current || !sha) return;
    const saved = pendingReview(storage);
    if (saved.unreadable) { setUnreadable(true); return; }
    locked.current = true; setBusy(true); setError('');
    try {
      const sending = saved.pending || { key: crypto.randomUUID(), input: { expected_assembly_sha256: sha, decision, appearance_checked: appearance, motion_checked: motion, notes: notes.trim() } };
      localStorage.setItem(storage, JSON.stringify(sending)); setPending(sending);
      const value = await factoryApi.reviewNative(jobId, version, sending.input, sending.key);
      localStorage.removeItem(storage);
      if (alive.current) { setPending(null); setNotes(''); setAppearance(false); setMotion(false); setAgain(false); onChange(value); }
    } catch (reason) {
      if (isDefinitiveRejection(reason)) { localStorage.removeItem(storage); if (alive.current) setPending(null); }
      if (alive.current) setError((reason as Error).message);
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  function discard() {
    try { localStorage.removeItem(storage); } catch { /* Storage is closed; nothing kept there either. */ }
    setUnreadable(false); setPending(null); setError('');
  }
  if (recorded && !again && !pending && !unreadable) return <section className="native-review" aria-label="시각 검수 기록">
    <p role="status">시각 검수 · {decisionLabels[recorded]}{state.review?.reviewer_name ? ` · ${state.review.reviewer_name}` : ''}</p>
    <div className="meshy-buttons"><button onClick={() => { setError(''); setAgain(true); }}>다시 검수</button></div>
  </section>;
  return <section className="native-review" aria-label="시각 검수 기록">
    <fieldset disabled={busy || !!pending || unreadable}><legend>시각 검수</legend>
      <label><input type="checkbox" checked={appearance} onChange={event => setAppearance(event.target.checked)} />네 방향 외형 확인</label>
      <label><input type="checkbox" checked={motion} onChange={event => setMotion(event.target.checked)} />동작 확인</label>
      <label>검수 메모<textarea aria-label="검수 메모" minLength={5} maxLength={2000} value={notes} onChange={event => setNotes(event.target.value)} /></label>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {unreadable && <p role="alert">저장된 검수 요청 읽기 실패</p>}
    {pending && <p role="status">응답 확인 안 됨</p>}
    <div className="meshy-buttons">{unreadable
      ? <button onClick={discard}>저장된 검수 요청 지우기</button>
      : pending
        ? <button disabled={busy} onClick={() => void submit(pending.input.decision)}>검수 기록 복구</button>
        : <><button disabled={busy || !validNotes || !appearance || !motion} onClick={() => void submit('approved')}>시각 승인</button><button disabled={busy || !validNotes} onClick={() => void submit('changes_requested')}>수정 필요 기록</button></>}</div>
  </section>;
}
