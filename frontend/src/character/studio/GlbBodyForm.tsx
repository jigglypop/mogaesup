import { useEffect, useRef, useState } from 'react';
import type { FactoryJob } from '../factory/api';
import type { BodyType } from './base-bodies-api';
import { GlbUpload } from './GlbUpload';
import { glbBodiesApi, glbRecovery, readGlbDraft, type GlbBodyDraft } from './glb-bodies-api';

type Props = { bodyType: BodyType;
  onJob: (job: FactoryJob) => void; refreshJobs: () => Promise<unknown>; onBusy: (busy: boolean) => void };

export function GlbBodyForm({ bodyType, onJob, refreshJobs, onBusy }: Props) {
  const [draft, setDraft] = useState(() => readGlbDraft(bodyType));
  const [busy, setBusy] = useState(false), [checking, setChecking] = useState(!!draft.asset);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const locked = useRef(false);
  const recovery = glbRecovery(bodyType), pending = recovery.pending;
  const disabled = busy || checking || !!pending || !!recovery.error;
  const input = pending?.input;
  const mode = input?.import_mode ?? draft.import_mode;
  const motions = input?.generate_motions ?? draft.generate_motions;
  useEffect(() => { onBusy(busy || checking || !!pending); return () => onBusy(false); }, [busy, checking, !!pending, onBusy]);
  useEffect(() => {
    if (!draft.asset) return;
    const controller = new AbortController();
    setChecking(true);
    void glbBodiesApi.info(draft.asset.id, controller.signal)
      .then(asset => { if (!controller.signal.aborted) setDraft(value => ({ ...value, asset })); })
      .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [draft.asset?.id]);
  function update(value: Partial<GlbBodyDraft>) {
    const next = { ...draft, ...value };
    setDraft(next);
    try { glbBodiesApi.saveDraft(bodyType, next); setError(''); }
    catch { setError('입력을 브라우저에 저장하지 못했습니다. 저장 공간을 확인하세요.'); }
  }
  async function upload(file: File) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setNotice('');
    try {
      const asset = await glbBodiesApi.upload(file);
      update({ asset, filename: file.name });
    } finally { locked.current = false; setBusy(false); }
  }
  async function submit() {
    if (locked.current || (!pending && !draft.asset)) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const job = await glbBodiesApi.create(pending?.input || {
        name: draft.name.trim(), body_type: bodyType, model_asset: draft.asset!.id,
        import_mode: draft.import_mode, generate_motions: mode === 'rig' && draft.generate_motions,
        prepare_expression_uv: mode === 'rig' && draft.prepare_expression_uv,
      });
      onJob(job); setNotice('GLB 등록 작업을 접수했습니다.');
      await refreshJobs();
    } catch (reason) { setError((reason as Error).message); }
    finally { locked.current = false; setBusy(false); }
  }
  return <div className="base-body-glb">
    <label>이름<input maxLength={100} value={input?.name ?? draft.name} disabled={disabled} onChange={event => update({ name: event.target.value })} /></label>
    <GlbUpload disabled={disabled} maxMb={256} onUpload={upload} />
    {draft.asset && <div className="base-body-glb-info">
      <strong>{draft.filename || '등록된 GLB'}</strong>
      <span>삼각형 {draft.asset.triangles.toLocaleString()}개 · {(draft.asset.bytes / 1048576).toFixed(1)}MB</span>
      <span>{draft.asset.rigged ? `기존 골격 ${draft.asset.bone_count}본 · 동작 ${draft.asset.animations.length}개` : '리깅 없음'}</span>
      {!!draft.asset.animations.length && <span>{draft.asset.animations.join(' · ')}</span>}
    </div>}
    <fieldset disabled={disabled} className="base-body-import-mode"><legend>등록 방식</legend>
      <label className="base-body-check"><input type="radio" name={`glb-mode-${bodyType}`} checked={mode === 'register'} onChange={() => update({ import_mode: 'register' })} />바로 등록</label>
      <label className="base-body-check"><input type="radio" name={`glb-mode-${bodyType}`} checked={mode === 'rig'} onChange={() => update({ import_mode: 'rig' })} />새로 리깅 후 등록</label>
    </fieldset>
    {mode === 'rig' ? <>
      <label className="base-body-check"><input type="checkbox" checked={motions} disabled={disabled} onChange={event => update({ generate_motions: event.target.checked })} />저장된 기본 동작 5종 생성</label>
      <label className="base-body-check"><input type="checkbox" checked={input?.prepare_expression_uv ?? draft.prepare_expression_uv} disabled={disabled} onChange={event => update({ prepare_expression_uv: event.target.checked })} />표정용 빈 얼굴 준비</label>
      {(input?.prepare_expression_uv ?? draft.prepare_expression_uv) && <small>얼굴 색을 비우고 PNG 표정용 UV를 준비합니다. 입체 형상은 유지됩니다.</small>}
      <small>Meshy 유료 리깅 1회{motions ? ' · 기본 동작 5종' : ''} · 기존 골격·동작 교체</small>
    </> : <small>리깅 유무와 관계없이 원본 메시·텍스처·골격·동작을 그대로 저장합니다.</small>}
    <button className="base-body-create" onClick={() => void submit()} disabled={busy || checking || !!recovery.error || (!pending && (!draft.name.trim() || !draft.asset))}>{busy ? '접수 중' : pending ? '같은 GLB 요청 복구' : mode === 'rig' ? '새 리깅 시작 후 등록' : '바로 등록'}</button>
    {pending && <p className="base-body-recovery">저장된 GLB와 같은 요청 키로 접수 결과를 확인합니다.</p>}
    {(error || recovery.error) && <p role="alert">{error || recovery.error}</p>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
