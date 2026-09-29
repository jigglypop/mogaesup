import { useCallback, useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent } from 'react';
import { api, request } from '../api';
import { useLiveCharacters } from '../use-live-characters';
import { usePolling } from '../use-polling';
import { factoryApi, type BodyProfileState, type FactoryJob, type ImageRetry } from './api';
import type { Blueprint } from './image-layers';
import { NativeAssembly } from './NativeAssembly';
import { ProductionProgress } from './ProductionProgress';
import { StageRunner } from './StageRunner';
import { PartProgress } from './PartProgress';
import { RigRecovery } from './RigRecovery';
import { isCatalogJobDeleted, type Catalog } from '../studio/api';
import './character-factory.css';
import { MeshyOptionsEditor } from '../studio/MeshyOptionsEditor';
import { useMeshyOptions, meshyOptionsError, sharedMeshyScope } from '../studio/meshy-options';

const partSlots = ['body', 'hair', 'hat', 'top', 'bottom', 'shoes'] as const;

// The workspace owns the shared job list, catalog and common body; this screen only reads them.
type CharacterFactoryProps = {
  jobs: FactoryJob[]; jobsLoading: boolean; jobsError: string;
  catalog?: Catalog; catalogError: string;
  bodyProfile?: BodyProfileState; bodyProfileError: string;
  onJob: (job: FactoryJob) => void; refreshJobs: () => Promise<unknown>;
};

function clipboardImage(data: DataTransfer | null) {
  if (!data) return undefined;
  return [...data.files].find(isSupportedImage);
}

function hasDraggedFiles(data: DataTransfer) {
  return [...data.types].includes('Files');
}

function isSupportedImage(file: File) {
  return file.type === 'image/png' || file.type === 'image/jpeg';
}

// Photo characters: a new body from a photo, or photo parts on a chosen body (several slots).
// Base bodies, uploaded GLBs and single-part or hair results belong to the other screens.
function isPhotoJob(job: FactoryJob) {
  return !job.base_body && job.input_kind !== 'glb' && (!job.base_job_id || (job.requested_slots?.length || 0) > 1);
}

export function usableBase(job: FactoryJob, catalog?: Catalog) {
  return !job.base_job_id && ['complete', 'expressions'].includes(job.character_flow?.stage || '')
    && job.assembly_origin !== 'uploaded_glb'
    && !isCatalogJobDeleted(job, catalog) && !catalog?.items[job.id]?.archived && !catalog?.parts?.[`${job.id}:body`]?.deleted;
}

export function CharacterFactory({ jobs: listedJobs, jobsLoading, jobsError, catalog, catalogError, bodyProfile, bodyProfileError,
  onJob, refreshJobs }: CharacterFactoryProps) {
  const characterQuery = 'photoCharacter', jobQuery = 'photoJob';
  const live = useLiveCharacters();
  const [characterId, setCharacterId] = useState(new URLSearchParams(location.search).get(characterQuery) || '');
  const [jobId, setJobId] = useState(new URLSearchParams(location.search).get(jobQuery) || '');
  const readSelected = useCallback((signal: AbortSignal) => jobId ? factoryApi.detail(jobId, signal) : Promise.resolve(null), [jobId]);
  const selectedJob = usePolling(readSelected, value => value?.character_flow?.busy ? 5000 : 15000);
  const configuration = usePolling(factoryApi.capabilities, 30000);
  const currentJob = selectedJob.value?.id === jobId ? selectedJob.value : null;
  const jobs = currentJob ? [currentJob, ...listedJobs.filter(item => item.id !== currentJob.id)] : listedJobs;
  const capabilities = configuration.value;
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const meshy = useMeshyOptions(sharedMeshyScope);
  const [meshyUploading, setMeshyUploading] = useState(false);
  const [draggingPhoto, setDraggingPhoto] = useState(false);
  const [hairLength, setHairLength] = useState<'source' | 'short' | 'long'>('source');
  const [baseId, setBaseId] = useState(new URLSearchParams(location.search).get('photoBase') || '');
  const [useCommonBody, setUseCommonBody] = useState(!new URLSearchParams(location.search).has('photoBase') && new URLSearchParams(location.search).get('photoBody') !== 'new');
  const locked = useRef(false), alive = useRef(true), fileInput = useRef<HTMLInputElement>(null), dragDepth = useRef(0);
  const partJobs = jobs.filter(j => j.production_mode === 'character_parts').sort((a, b) => b.created_at.localeCompare(a.created_at));
  const photoJobs = partJobs.filter(isPhotoJob);
  const suggested = photoJobs.find(j => j.id === jobId) || photoJobs[0];
  const source = characterId ? live.characters.find(c => c.id === characterId) : live.characters.find(c => c.id === suggested?.character_id) || live.characters.find(c => c.artifacts.some(a => a.id === 'reference'));
  const versions = photoJobs.filter(j => j.character_id === (source?.id || characterId || suggested?.character_id));
  const job = jobId ? versions.find(j => j.id === jobId) : versions[0];
  const reference = source?.artifacts.find(a => a.id === 'reference');
  const running = job?.character_flow?.busy ?? (!!job && ['pipeline_queued', 'pipeline_running', 'accepted', 'running'].includes(job.status));
  const connectionError = jobsError || configuration.error || live.failure;
  const pending = source ? factoryApi.pendingImage(source.id) : null;
  const commonBodyId = bodyProfile?.body?.job_id || '';
  const selectedBaseId = pending ? pending.input.base_job_id || '' : baseId || (useCommonBody ? commonBodyId : '');
  const bases = partJobs.filter(item => usableBase(item, catalog));
  const readBase = useCallback(async (signal: AbortSignal) => selectedBaseId
    ? { id: selectedBaseId, native: await factoryApi.nativeParts(selectedBaseId, signal) } : null, [selectedBaseId]);
  const baseState = usePolling(readBase, 15000);
  const selectedBase = baseState.value?.id === selectedBaseId ? baseState.value.native : undefined;
  const selectedBaseVersion = pending?.input.base_version || (useCommonBody && selectedBaseId === commonBodyId
    ? bodyProfile?.body?.version : selectedBase?.version);
  const baseListed = !selectedBaseId || bases.some(item => item.id === selectedBaseId);
  const baseReady = !selectedBaseId || (baseListed
    && selectedBase?.status === 'review_required' && !!selectedBaseVersion
    && selectedBase.artifacts.some(item => item.name === 'body.glb'));
  const generationSlots = selectedBaseId ? partSlots.filter(slot => slot !== 'body') : partSlots;
  const compatible = capabilities?.character_pipeline === 'parts_to_character_v2'
    && partSlots.every(slot => capabilities.slots?.includes(slot));
  const produceAction = capabilities?.next_actions.find(a => a.id === 'produce_images');
  const canGenerate = compatible && !!produceAction?.enabled;
  const retryBatch = job?.next_actions?.find(a => a.id === 'retry_images' && a.enabled)?.images;
  const normalizedReference = job?.artifacts.find(a => a.name === job.reference_preparation?.file);
  const normalizedSideReference = job?.artifacts.find(a => a.name === job.reference_preparation?.views?.side?.file);
  const normalizesReference = pending ? !!pending.input.prepare_reference : true;
  const generatesExpressions = pending ? !!pending.input.default_expressions : true;
  const modelCount = pending ? pending.input.slots.length - (selectedBaseId ? 1 : 0) : generationSlots.length;
  const partViewCount = pending
    ? pending.input.view_mode === 'single' ? 1 : pending.input.view_mode === 'front_side_back' ? 3 : 2
    : 3;
  const partImageCount = modelCount * partViewCount;
  const totalImageCount = partImageCount + (normalizesReference ? 2 : 0) + (generatesExpressions ? 5 : 0);
  // On a chosen base body, parts made from the body itself (body_shell) need no 3D request.
  const methodDefaults = capabilities?.part_methods?.defaults || {};
  const shellCount = selectedBaseId ? (pending?.input.slots || generationSlots).filter(slot => methodDefaults[slot] === 'body_shell').length : 0;
  const providerModelCount = Math.max(0, modelCount - shellCount);
  // The server refuses the same request; showing it first avoids paying for images that cannot become 3D.
  const creditNeed = capabilities?.meshy_credit_estimate
    ? providerModelCount * capabilities.meshy_credit_estimate.part + (selectedBaseId ? 0 : capabilities.meshy_credit_estimate.rig) : 0;
  const creditsShort = capabilities?.meshy_balance != null && capabilities.meshy_balance < creditNeed;
  const blockedReason = !capabilities || pending || running ? '' : !compatible ? '서버 버전 불일치'
    : !canGenerate ? produceAction?.reason || ''
    : creditsShort ? `Meshy 크레딧 부족 · 필요 약 ${creditNeed} · 잔여 ${capabilities.meshy_balance} · 충전 후 생성하세요`
    : !reference ? '' : !baseListed ? '선택한 기본 몸을 사용할 수 없습니다 · 다른 기본 몸을 선택하세요'
    : !baseReady ? baseState.error || '기본 몸 확인 중' : '';

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (baseId) { query.set('photoBase', baseId); query.delete('photoBody'); }
    else { query.delete('photoBase'); if (useCommonBody) query.delete('photoBody'); else query.set('photoBody', 'new'); }
    history.replaceState(null, '', `${location.pathname}?${query}${location.hash}`);
  }, [baseId, useCommonBody]);
  function remember(character: string, job = '') {
    setCharacterId(character); setJobId(job);
    const q = new URLSearchParams(location.search);
    if (character) q.set(characterQuery, character); else q.delete(characterQuery);
    if (job) q.set(jobQuery, job); else q.delete(jobQuery);
    history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
  }
  async function upload(file?: File) {
    if (!file || locked.current) return;
    if (!isSupportedImage(file)) { setError('PNG 또는 JPEG 사진을 선택해 주세요.'); return; }
    locked.current = true; setBusy(true); setError('');
    try {
      const character = await api.create(file.name.replace(/\.[^.]+$/, ''), null);
      await api.upload(character, file, 'image');
      if (!alive.current) return;
      remember(character.id); await live.refresh();
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  const uploadCurrent = useRef(upload);
  uploadCurrent.current = upload;
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      const file = clipboardImage(event.clipboardData);
      if (!file) return;
      event.preventDefault();
      void uploadCurrent.current(file);
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, []);
  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => {
      if (!event.dataTransfer || !hasDraggedFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.type === 'drop') {
        dragDepth.current = 0;
        setDraggingPhoto(false);
      }
    };
    window.addEventListener('dragover', preventFileNavigation);
    window.addEventListener('drop', preventFileNavigation);
    return () => {
      window.removeEventListener('dragover', preventFileNavigation);
      window.removeEventListener('drop', preventFileNavigation);
    };
  }, []);
  function pasteUpload(event: ReactClipboardEvent<HTMLElement>) {
    const file = clipboardImage(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    void upload(file);
  }
  function enterPhotoDrop(event: ReactDragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (locked.current) return;
    dragDepth.current += 1;
    setDraggingPhoto(true);
  }
  function leavePhotoDrop(event: ReactDragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDraggingPhoto(false);
  }
  function overPhotoDrop(event: ReactDragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = locked.current ? 'none' : 'copy';
  }
  function dropPhoto(event: ReactDragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDraggingPhoto(false);
    if (locked.current) return;
    const files = [...event.dataTransfer.files];
    if (files.length !== 1 || !isSupportedImage(files[0])) {
      setError('PNG 또는 JPEG 사진 1개만 놓아 주세요.');
      return;
    }
    void upload(files[0]);
  }
  async function produce() {
    if (!source || locked.current || (!pending && !baseReady)) return;
    locked.current = true; setBusy(true); setError('');
    try {
      let result: FactoryJob;
      if (pending) result = await factoryApi.produceImage(pending.input);
      else {
        if (meshyOptionsError(meshy.options)) throw new Error(meshyOptionsError(meshy.options));
        const blueprint = await request<Blueprint>(`/api/avatar-blueprints/${source.id}`);
        if (!blueprint.source_sha256) throw new Error('캐릭터 사진을 먼저 올려 주세요.');
        result = await factoryApi.produceImage({ character_id: source.id, source_sha256: blueprint.source_sha256,
          blueprint_revision: blueprint.revision, production_mode: 'character_parts', view_mode: 'front_side_back', image_mode: 'generate',
          prepare_reference: true, default_expressions: true, meshy_options: meshy.options,
          ...(selectedBaseId && selectedBaseVersion ? { base_job_id: selectedBaseId, base_version: selectedBaseVersion } : {}),
          slots: [...partSlots], hair_length: hairLength, body_purpose: 'wardrobe_base', rig_with_meshy: true });
      }
      if (alive.current) { onJob(result); remember(result.character_id, result.id); }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  async function retryImages(images: ImageRetry[]) {
    if (!job || locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const result = await factoryApi.retryImages(job.id, images);
      if (alive.current) { onJob(result); selectedJob.setValue(result); }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  return <div className="character-factory character-factory-embedded">
    <main>
      <section className="character-input">
        <h1>사진으로 전체 생성</h1>
        <label className={`character-upload ${draggingPhoto ? 'is-dragging' : ''}`} tabIndex={busy ? -1 : 0} role="button" aria-disabled={busy} onPaste={pasteUpload} onDragEnter={enterPhotoDrop} onDragLeave={leavePhotoDrop} onDragOver={overPhotoDrop} onDrop={dropPhoto} onKeyDown={event => { if (!busy && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); fileInput.current?.click(); } }}>{reference ? <img src={reference.url} alt="캐릭터 원본 사진" /> : <span>{live.loading && (characterId || suggested) ? '사진 불러오는 중' : '캐릭터 사진을 클릭하거나 놓거나 Ctrl+V로 붙여넣으세요'}</span>}<b>{reference ? '사진 바꾸기 · 끌어놓기 가능' : '사진 선택 · 끌어놓기 가능'}</b><input ref={fileInput} aria-label="캐릭터 사진" type="file" accept="image/png,image/jpeg" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} /></label>
        {live.characters.length > 0 && <details className="character-history"><summary>작업 선택</summary><select aria-label="작업 선택" disabled={busy} value={source?.id || ''} onChange={e => remember(e.target.value)}><option value="" disabled>선택</option>{live.characters.filter(c => c.artifacts.some(a => a.id === 'reference') || photoJobs.some(j => j.character_id === c.id)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></details>}
        <label className="character-history">기본 몸<select aria-label="기본 몸" value={selectedBaseId} disabled={busy || running || !!pending} onChange={event => { setBaseId(event.target.value); setUseCommonBody(false); }}>
          <option value="">사진에서 새 기본 몸 생성</option>
          {selectedBaseId && !bases.some(item => item.id === selectedBaseId) && <option value={selectedBaseId}>선택한 기본 몸 · {selectedBaseId}</option>}
          {bases.map(item => <option key={item.id} value={item.id}>{item.id === commonBodyId ? '공통 기본 몸 · ' : ''}{catalog?.parts?.[`${item.id}:body`]?.name || catalog?.items[item.id]?.name || item.character_name} · {new Date(item.created_at).toLocaleString()}</option>)}
        </select></label>
        {selectedBaseId && <div className="character-base-preview">
          {selectedBase?.artifacts.find(item => item.name === 'body-front.png') && <img className="base-portrait" src={selectedBase.artifacts.find(item => item.name === 'body-front.png')!.url} alt="선택한 기본 몸만 미리보기" />}
        </div>}
        <label className="character-history">머리카락 길이<select aria-label="머리카락 길이" disabled={busy || running || !!pending} value={pending ? pending.input.hair_length || 'source' : hairLength} onChange={e => setHairLength(e.target.value as typeof hairLength)}><option value="source">원본대로</option><option value="short">숏컷</option><option value="long">롱컷</option></select></label>
        <a className="prompt-management-link" href="/?tab=prompts&promptGroup=parts" target="_blank" rel="noreferrer">프롬프트 관리 열기</a>
        <MeshyOptionsEditor scope={sharedMeshyScope} value={pending?.input.meshy_options || meshy.options} disabled={busy || running || !!pending} onChange={meshy.setOptions} onUploading={setMeshyUploading} />
        {meshy.storageError && <p role="alert">{meshy.storageError}</p>}
        <button className="character-create" disabled={busy || meshyUploading || (!pending && (running || !reference || !compatible || !canGenerate || !baseReady || creditsShort))} onClick={() => void produce()}>{busy ? '접수 중' : pending ? '요청 복구' : running ? '생성 중' : selectedBaseId ? '선택한 몸에 사진 파츠 생성' : '사진으로 전체 생성'}</button>
        <small className="character-generation">유료 이미지 {totalImageCount}장 · 3D {providerModelCount}개 · {selectedBaseId ? '기존 몸·리깅·동작 재사용' : '리깅 1회 · 기본 동작'}{capabilities?.meshy_balance != null && ` · Meshy 잔여 크레딧 ${capabilities.meshy_balance.toLocaleString()}`}</small>
        {blockedReason && <p className="character-status" role="status">{blockedReason}</p>}
        {(error || connectionError || catalogError || bodyProfileError) && <p role="alert">{error || connectionError || catalogError || bodyProfileError}</p>}
        {jobId && !job && !jobsLoading && !connectionError && <p role="alert">선택한 작업을 찾을 수 없습니다. 제작 버전을 다시 선택해 주세요.</p>}
        {versions.length > 1 && <label className="character-history">제작 버전<select aria-label="제작 버전" value={job?.id || ''} onChange={e => remember(source!.id, e.target.value)}><option value="" disabled>버전 선택</option>{versions.map(v => <option key={v.id} value={v.id}>{new Date(v.created_at).toLocaleString()}</option>)}</select></label>}
        {retryBatch && <button disabled={busy || running} onClick={() => void retryImages(retryBatch)}>실패한 이미지 재요청 · 유료 {retryBatch.length}장</button>}
        {job && <PartProgress job={job} busy={busy} retryImage={(slot, view, failure_id) => retryImages([{slot, view, failure_id}])} />}
      </section>
      <section className="character-result" aria-label="완성 캐릭터">
        {job && <ProductionProgress job={job} offline={!!connectionError} />}
        {job?.reference_preparation && <section className="character-reference" aria-label="공통 규격 이미지">
          <h3>공통 규격 · 배경 제거</h3>
          {normalizedReference ? <a href={normalizedReference.url} target="_blank" rel="noreferrer"><img src={normalizedReference.url} alt="공통 규격으로 맞추고 배경을 제거한 캐릭터" /></a>
            : <p role="status">{job.reference_preparation.failure?.message || job.error || (job.reference_preparation.status === 'pending' ? '대기 중' : '규격 이미지 준비 중')}</p>}
          {normalizedSideReference && <a href={normalizedSideReference.url} target="_blank" rel="noreferrer"><img src={normalizedSideReference.url} alt={'공통 규격으로 맞추고 배경을 제거한 오른쪽 측면 캐릭터'} /></a>}
        </section>}
        {job && <RigRecovery jobId={job.id} onComplete={() => { void refreshJobs(); }} />}
        {job && <StageRunner key={`stages:${job.id}`} jobId={job.id} onChange={() => { void refreshJobs(); void selectedJob.refresh(); }} />}
        {job ? <NativeAssembly key={`assembly:${job.id}`} jobId={job.id} simple flow={job.character_flow} /> : <div className="character-empty"><h2>캐릭터 미리보기</h2><p>{jobsLoading ? '작업 불러오는 중…' : '제작 결과 없음'}</p></div>}
      </section>
    </main>
  </div>;
}
