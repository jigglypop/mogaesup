import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { can } from '../../auth/can';
import { isDefinitiveRejection } from '../api';
import { factoryApi, type NativePartsState } from './api';

type ReviewInput = Parameters<typeof factoryApi.reviewNative>[2];
type PendingReview = { key: string; input: ReviewInput };
function pendingReview(storage: string): PendingReview | null {
  const raw = sessionStorage.getItem(storage);
  if (!raw) return null;
  const value = JSON.parse(raw) as PendingReview;
  if (!value?.key || !/^[a-f0-9]{64}$/.test(value.input?.expected_assembly_sha256 || '') || !['approved', 'changes_requested'].includes(value.input.decision)
    || typeof value.input.notes !== 'string' || typeof value.input.appearance_checked !== 'boolean' || typeof value.input.motion_checked !== 'boolean') throw new Error('저장된 검수 요청을 읽지 못했습니다.');
  return value;
}

export function NativeReview({ jobId, state, onChange }: { jobId: string; state: NativePartsState; onChange(value: NativePartsState): void }) {
  const { user } = useAuth();
  const version = state.version!, storage = `gaesup.native-review:${jobId}:${version}`;
  const [notes, setNotes] = useState(''), [appearance, setAppearance] = useState(false), [motion, setMotion] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [pending, setPending] = useState<PendingReview | null>(null);
  const locked = useRef(false), alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    try {
      const saved = pendingReview(storage); setPending(saved);
      if (saved) { setNotes(saved.input.notes); setAppearance(saved.input.appearance_checked); setMotion(saved.input.motion_checked); }
    } catch (reason) { setError((reason as Error).message); }
    return () => { alive.current = false; };
  }, [storage]);
  if (!can(user, 'operator')) return null;
  const sha = state.assembly_sha256 || state.artifacts.find(item => item.name === 'model.glb')?.sha256;
  if (!sha || !/^[a-f0-9]{64}$/.test(sha)) return null;
  const validNotes = notes.trim().length >= 5 && notes.trim().length <= 2000;
  async function submit(decision: ReviewInput['decision']) {
    if (locked.current || !sha) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const saved = pendingReview(storage) || { key: crypto.randomUUID(), input: { expected_assembly_sha256: sha, decision, appearance_checked: appearance, motion_checked: motion, notes: notes.trim() } };
      sessionStorage.setItem(storage, JSON.stringify(saved)); setPending(saved);
      const value = await factoryApi.reviewNative(jobId, version, saved.input, saved.key);
      sessionStorage.removeItem(storage);
      if (alive.current) { setPending(null); onChange(value); }
    } catch (reason) {
      if (isDefinitiveRejection(reason)) { sessionStorage.removeItem(storage); if (alive.current) setPending(null); }
      if (alive.current) setError((reason as Error).message);
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="native-review" aria-label="시각 검수 기록">
    <fieldset disabled={busy || !!pending}><legend>시각 검수</legend>
      <label><input type="checkbox" checked={appearance} onChange={event => setAppearance(event.target.checked)} />네 방향 외형 확인</label>
      <label><input type="checkbox" checked={motion} onChange={event => setMotion(event.target.checked)} />동작 확인</label>
      <label>검수 메모<textarea aria-label="검수 메모" minLength={5} maxLength={2000} value={notes} onChange={event => setNotes(event.target.value)} /></label>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <div className="meshy-buttons">{pending
      ? <button disabled={busy} onClick={() => void submit(pending.input.decision)}>검수 기록 복구</button>
      : <><button disabled={busy || !validNotes || !appearance || !motion} onClick={() => void submit('approved')}>시각 승인</button><button disabled={busy || !validNotes} onClick={() => void submit('changes_requested')}>수정 필요 기록</button></>}</div>
  </section>;
}
