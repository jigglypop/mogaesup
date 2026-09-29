import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { factoryApi, type FactoryJob } from '../factory/api';
import { MeshyMotion } from '../factory/MeshyMotion';
import { NativeAssembly } from '../factory/NativeAssembly';
import { ProductionProgress } from '../factory/ProductionProgress';
import { StageRunner } from '../factory/StageRunner';
import { baseBodiesApi, readBaseBodyDraft, saveBaseBodyDraft, type BaseBodyDraft, type BodyType, type BodyView } from './base-bodies-api';
import './base-bodies.css';
import { GlbBodyForm } from './GlbBodyForm';
import { WardrobeBodies } from './WardrobeBodies';

type Props = { jobs: FactoryJob[]; selectedJobId?: string; onJob: (job: FactoryJob) => void; refreshJobs: () => Promise<unknown> };
type RigOption = { jobId: string; version: string; label: string };
const bodyLabels: Record<BodyType, string> = { male: '남성형', female: '여성형' };
const viewLabels: Record<BodyView, string> = { front: '정면', side: '측면', back: '후면' };
const bodyViews: BodyView[] = ['front', 'side', 'back'];

function bodyTypeOf(job: FactoryJob): BodyType | undefined {
  return job.base_body?.body_type;
}

function isSupportedImage(file: File) {
  return file.type === 'image/png' || file.type === 'image/jpeg';
}
function imageFromClipboard(data: DataTransfer | null) {
  return data ? [...data.files].find(isSupportedImage) : undefined;
}

function BodyViewUpload({ view, asset, disabled, busy, onUpload, onClear }: {
  view: BodyView; asset?: string; disabled: boolean; busy: boolean;
  onUpload: (file: File) => void; onClear: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  function accept(file?: File) {
    if (file && !disabled) onUpload(file);
  }
  function drop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault(); event.stopPropagation(); setDragging(false);
    accept(event.dataTransfer.files[0]);
  }
  function paste(event: ClipboardEvent<HTMLLabelElement>) {
    const file = imageFromClipboard(event.clipboardData);
    if (!file || disabled) return;
    event.preventDefault(); accept(file);
  }
  return <div className="base-body-view">
    <label className={`base-body-drop ${dragging ? 'is-dragging' : ''}`} tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
      onPaste={paste} onDragEnter={event => { event.preventDefault(); if (!disabled) setDragging(true); }} onDragOver={event => event.preventDefault()}
      onDragLeave={event => { event.preventDefault(); setDragging(false); }} onDrop={drop}
      onKeyDown={event => { if (!disabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); input.current?.click(); } }}>
      {asset ? <img src={baseBodiesApi.imageUrl(asset)} alt={`${viewLabels[view]} 기본 몸`} /> : <span>{viewLabels[view]} PNG/JPEG</span>}
      <strong>{busy ? '등록 중' : asset ? '이미지 바꾸기' : '선택 · 놓기 · 붙여넣기'}</strong>
      <input ref={input} type="file" accept="image/png,image/jpeg" disabled={disabled} aria-label={`${viewLabels[view]} 이미지`} onChange={event => { accept(event.target.files?.[0]); event.target.value = ''; }} />
    </label>
    {asset && <button type="button" disabled={disabled} onClick={onClear}>제거</button>}
  </div>;
}

export default function BaseBodies({ jobs, selectedJobId, onJob, refreshJobs }: Props) {
  const [bodyType, setBodyType] = useState<BodyType>('male');
  const [sourceMode, setSourceMode] = useState<'glb' | 'images'>('glb');
  const [glbBusy, setGlbBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<BodyType, BaseBodyDraft>>(() => ({ male: readBaseBodyDraft('male'), female: readBaseBodyDraft('female') }));
  const [selected, setSelected] = useState<Record<BodyType, string>>({ male: '', female: '' });
  const [rigOptions, setRigOptions] = useState<RigOption[]>([]);
  const [uploading, setUploading] = useState<BodyView>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  // The motion panel downloads and parses the rigged model; mount it only while open.
  const [motionOpen, setMotionOpen] = useState(false);
  const locked = useRef(false);
  const draft = drafts[bodyType];
  const recovery = baseBodiesApi.recovery(bodyType), pending = recovery.pending;
  const input = pending?.input;
  const shownViews = input?.views || draft.views;
  const shownRig = input ? input.rig_source : draft.rig_source;
  const inputLocked = busy || !!uploading || !!pending || !!recovery.error;
  const savedJobs = useMemo(() => jobs.filter(job => bodyTypeOf(job) === bodyType), [jobs, bodyType]);
  const selectedJob = savedJobs.find(job => job.id === selected[bodyType]) || savedJobs[0];
  const requestedBodyType = jobs.find(job => job.id === selectedJobId)?.base_body?.body_type;
  useEffect(() => {
    if (!selectedJobId || !requestedBodyType) return;
    setBodyType(requestedBodyType);
    setSelected(current => ({ ...current, [requestedBodyType]: selectedJobId }));
  }, [selectedJobId, requestedBodyType]);
  const rigSourceRefreshKey = useMemo(() => jobs
    .filter(job => !job.base_job_id && ['complete', 'expressions'].includes(job.character_flow?.stage || ''))
    .map(job => `${job.id}:${job.assembly_version || ''}`).sort().join('|'), [jobs]);

  useEffect(() => {
    try { saveBaseBodyDraft('male', drafts.male); saveBaseBodyDraft('female', drafts.female); }
    catch { setError('기본 몸 이미지 선택을 브라우저에 저장할 수 없습니다. 저장 공간을 확인해 주세요.'); }
  }, [drafts]);
  useEffect(() => {
    const controller = new AbortController();
    void factoryApi.rigTransferSources(controller.signal)
      .then(result => { if (!controller.signal.aborted) setRigOptions(result.items.map(item => ({ jobId: item.job_id, version: item.version, label: item.name }))); })
      .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message); });
    return () => controller.abort();
  }, [rigSourceRefreshKey]);

  function update(change: Partial<BaseBodyDraft>) {
    setDrafts(current => ({ ...current, [bodyType]: { ...current[bodyType], ...change } }));
  }
  function reuseSavedInput() {
    const views = selectedJob?.base_body?.views;
    if (inputLocked || !views || !bodyViews.every(view => views[view])) return;
    const previousRig = selectedJob.base_body?.rig_source;
    const rig = rigOptions.find(option => option.jobId === previousRig?.job_id && option.version === previousRig.version)
      || rigOptions.find(option => option.jobId === selectedJob.id && option.version === selectedJob.assembly_version);
    update({ name: selectedJob.character_name, views: { ...views },
      rig_source: rig ? { job_id: rig.jobId, version: rig.version } : undefined });
    setError(''); setNotice('');
  }
  async function upload(view: BodyView, file: File) {
    if (locked.current) return;
    if (!isSupportedImage(file)) { setError('PNG 또는 JPEG 이미지를 선택해 주세요.'); return; }
    if (file.size > 32 * 1024 * 1024) { setError('이미지는 32MB 이하로 선택해 주세요.'); return; }
    locked.current = true; setUploading(view); setError(''); setNotice('');
    try {
      const asset = await baseBodiesApi.upload(file);
      const nextDraft = { ...draft, views: { ...draft.views, [view]: asset.id } };
      try { saveBaseBodyDraft(bodyType, nextDraft); }
      catch { setError('등록한 이미지 ID를 브라우저에 저장할 수 없습니다. 이 화면을 닫지 말고 저장 공간을 확인해 주세요.'); }
      setDrafts(current => ({ ...current, [bodyType]: nextDraft }));
    } catch (reason) { setError((reason as Error).message); }
    finally { locked.current = false; setUploading(undefined); }
  }
  async function create() {
    if (locked.current) return;
    const request = pending?.input || (bodyViews.every(view => draft.views[view]) ? {
      name: draft.name.trim(), body_type: bodyType,
      views: Object.fromEntries(bodyViews.map(view => [view, draft.views[view]!])) as Record<BodyView, string>,
      ...(draft.rig_source ? { rig_source: draft.rig_source } : {}),
    } : undefined);
    if (!request) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const job = await baseBodiesApi.create(request);
      onJob(job); setSelected(current => ({ ...current, [bodyType]: job.id }));
      await refreshJobs(); setNotice('기본 몸 생성 작업을 접수했습니다.');
    } catch (reason) { setError((reason as Error).message); }
    finally { locked.current = false; setBusy(false); }
  }
  const complete = bodyViews.every(view => !!draft.views[view]);
  const rigValue = shownRig ? `${shownRig.job_id}:${shownRig.version}` : '';

  return <div className="base-bodies workspace-content">
    <div className="workspace-heading"><h1>기본 몸</h1><div className="base-body-tabs" role="tablist" aria-label="기본 몸 타입">{(['male', 'female'] as const).map(value => <button key={value} role="tab" aria-selected={bodyType === value} disabled={busy || !!uploading || glbBusy} onClick={() => { setBodyType(value); setError(''); setNotice(''); }}>{bodyLabels[value]}</button>)}</div></div>
    <WardrobeBodies jobs={jobs} selectedJob={selectedJob} onSelect={job => {
      const type = bodyTypeOf(job);
      if (!type || busy || uploading || glbBusy) return;
      setBodyType(type); setSelected(current => ({ ...current, [type]: job.id }));
    }} />
    <div className="base-body-layout">
      <section className="base-body-compose" aria-busy={busy || !!uploading}>
        <div className="base-body-tabs base-body-source" role="tablist" aria-label="기본 몸 입력 방식">
          <button role="tab" aria-selected={sourceMode === 'glb' && !pending} disabled={busy || !!uploading || glbBusy || !!pending} onClick={() => setSourceMode('glb')}>GLB 등록</button>
          <button role="tab" aria-selected={sourceMode === 'images' || !!pending} disabled={busy || !!uploading || glbBusy} onClick={() => setSourceMode('images')}>이미지로 생성</button>
        </div>
        {sourceMode === 'glb' && !pending ? <GlbBodyForm key={bodyType} bodyType={bodyType} onBusy={setGlbBusy}
          onJob={job => { onJob(job); setSelected(current => ({ ...current, [bodyType]: job.id })); }} refreshJobs={refreshJobs} /> : <>
        <label>이름<input value={input?.name || draft.name} disabled={inputLocked} maxLength={80} onChange={event => update({ name: event.target.value })} /></label>
        {selectedJob?.base_body?.views && <button type="button" disabled={inputLocked || !bodyViews.every(view => selectedJob.base_body?.views?.[view])} onClick={reuseSavedInput}>저장된 원본 불러오기</button>}
        <div className="base-body-views">{bodyViews.map(view => <BodyViewUpload key={view} view={view} asset={shownViews[view]} disabled={inputLocked || !!uploading} busy={uploading === view} onUpload={file => void upload(view, file)} onClear={() => update({ views: Object.fromEntries(Object.entries(draft.views).filter(([key]) => key !== view)) })} />)}</div>
        <label>리깅 기준 몸<select value={rigValue} disabled={inputLocked} onChange={event => {
          const option = rigOptions.find(item => `${item.jobId}:${item.version}` === event.target.value);
          update({ rig_source: option ? { job_id: option.jobId, version: option.version } : undefined });
        }}><option value="">새 리깅 생성</option>{rigValue && !rigOptions.some(item => `${item.jobId}:${item.version}` === rigValue) && <option value={rigValue}>{rigValue}</option>}{rigOptions.map(item => <option key={`${item.jobId}:${item.version}`} value={`${item.jobId}:${item.version}`}>{item.label}</option>)}</select></label>
        <button className="base-body-create" disabled={busy || !!uploading || !!recovery.error || (!pending && (!draft.name.trim() || !complete))} onClick={() => void create()}>{busy ? '접수 확인 중' : pending ? '같은 요청 복구' : '기본 몸 3D 생성'}</button>
        <small>유료 Meshy 3D 1회{shownRig ? ' · 저장된 리깅 재사용' : ' · 리깅 1회 · 기본 동작'}</small>
        {pending && <p className="base-body-recovery">응답이 확인되지 않은 {bodyLabels[bodyType]} 요청입니다. 저장된 이미지와 요청 키로 복구합니다.</p>}
        {(error || recovery.error) && <p role="alert">{error || recovery.error}</p>}{notice && <p role="status">{notice}</p>}
        </>}
      </section>
      <section className="base-body-results">
        <div className="base-body-saved-heading"><h2>저장된 {bodyLabels[bodyType]}</h2>{savedJobs.length > 0 && <select aria-label={`저장된 ${bodyLabels[bodyType]}`} value={selectedJob?.id || ''} onChange={event => setSelected(current => ({ ...current, [bodyType]: event.target.value }))}>{savedJobs.map(job => <option key={job.id} value={job.id}>{job.character_name} · {new Date(job.created_at).toLocaleString()}</option>)}</select>}</div>
        {selectedJob ? <><ProductionProgress key={`progress:${selectedJob.id}`} job={selectedJob} offline={false} />{selectedJob.error && <p className="base-body-job-error" role="alert">{selectedJob.error}</p>}<StageRunner key={`stages:${selectedJob.id}`} jobId={selectedJob.id} onChange={() => void refreshJobs()} /><NativeAssembly key={`assembly:${selectedJob.id}`} jobId={selectedJob.id} simple flow={selectedJob.character_flow} />{(selectedJob.input_kind !== 'glb' || selectedJob.base_body?.import_mode === 'rig') && <details className="base-body-motion" onToggle={event => setMotionOpen(event.currentTarget.open)}><summary>리깅·동작</summary>{motionOpen && <MeshyMotion key={`motion:${selectedJob.id}`} jobId={selectedJob.id} showRigRecovery={false} />}</details>}</> : <div className="base-body-empty">저장된 {bodyLabels[bodyType]} 기본 몸이 없습니다.</div>}
      </section>
    </div>
  </div>;
}
