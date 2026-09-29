import { useCallback, useEffect, useRef, useState } from 'react';
import { factoryApi, type FactoryJob } from '../factory/api';
import { partLabels } from '../factory/parts';
import { usePolling } from '../use-polling';
import { AssetModelPreview } from './AssetModelPreview';
import { GlbUpload } from './GlbUpload';
import { glbAssetsApi, glbAssetRecovery, glbPreparationRecovery, glbAssetSlots, type GlbAssetRecord, type GlbAssetSlot } from './glb-assets-api';
import './glb-assets.css';

type Props = { slot?: GlbAssetSlot; bases: FactoryJob[]; defaultBaseId?: string; onJob: (job: FactoryJob) => void };
const labels: Record<GlbAssetSlot, string> = { ...partLabels, body: '기본몸', hair: '헤어', hat: '모자·장식', top: '상의', bottom: '하의', shoes: '신발', weapon: '무기', tool: '도구', glasses: '안경', prop: '기물' };
const operationLabels: Record<string, string> = { accepted: '접수됨', pipeline_queued: '대기', pipeline_running: '처리 중', running: '처리 중', review_required: '저장 완료', complete: '저장 완료', failed: '중단', pipeline_paused: '이어가기 필요', recovery_required: '이어가기 필요' };

export function GlbAssetLibrary({ slot, bases, defaultBaseId, onJob }: Props) {
  const listing = usePolling(glbAssetsApi.list, 10000);
  const [kind, setKind] = useState<GlbAssetSlot>(slot || 'hair');
  const [name, setName] = useState(''), [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [baseId, setBaseId] = useState(defaultBaseId || ''), [bodyType, setBodyType] = useState<'male' | 'female'>('female');
  const lock = useRef(false);
  const effectiveSlot = slot || kind;
  const recovery = glbAssetRecovery();
  const visibleItems = (listing.value?.items || []).filter(item => !slot || item.slot === slot);
  const selected = visibleItems.find(item => item.id === selectedId);
  const preparing = selected ? glbPreparationRecovery(selected.id) : { pending: null, error: '' };
  const selectedBase = bases.find(item => item.id === baseId);
  const readBase = useCallback(async (signal: AbortSignal) => selectedBase
    ? { jobId: selectedBase.id, state: await factoryApi.nativeParts(selectedBase.id, signal) } : null, [selectedBase?.id]);
  const base = usePolling(readBase, 15000);
  const baseState = base.value?.jobId === selectedBase?.id ? base.value?.state : undefined;
  const fitReady = baseState?.status === 'review_required' && !!baseState.version && baseState.origin !== 'uploaded_glb';
  useEffect(() => { setSelectedId(''); }, [slot]);

  function accept(item: GlbAssetRecord) {
    listing.setValue(current => ({ items: [item, ...(current?.items || []).filter(value => value.id !== item.id)] }));
    setSelectedId(item.id); setNotice('GLB 원본 등록 완료');
    void listing.refresh();
  }
  async function upload(file: File) {
    if (lock.current) throw new Error('다른 요청을 처리 중입니다.');
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const asset = await glbAssetsApi.upload(file);
      const item = await glbAssetsApi.create({ name: (name.trim() || file.name.replace(/\.glb$/i, '')).slice(0, 100), slot: effectiveSlot, model_asset: asset.id });
      accept(item);
    } catch (reason) { setError((reason as Error).message); throw reason; }
    finally { lock.current = false; setBusy(false); }
  }
  async function recoverRegistration() {
    if (lock.current || !recovery.pending) return;
    lock.current = true; setBusy(true); setError('');
    try { accept(await glbAssetsApi.create(recovery.pending.input)); }
    catch (reason) { setError((reason as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  async function prepare(action: 'fit' | 'rig') {
    if (lock.current || !selected) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const input = preparing.pending?.input || (action === 'fit'
        ? { action, base_job_id: selectedBase?.id, base_version: baseState?.version }
        : { action, body_type: bodyType });
      const job = await glbAssetsApi.prepare(selected.id, input);
      setNotice(action === 'fit' ? '몸 맞추기·골격 연결 접수 완료' : '새 리깅 접수 완료');
      onJob(job); void listing.refresh();
    } catch (reason) { setError((reason as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  async function openOperation(id: string) {
    try { onJob(await factoryApi.detail(id)); }
    catch (reason) { setError((reason as Error).message); }
  }
  function details(item: GlbAssetRecord) {
    return <div className="glb-asset-details">
      <AssetModelPreview model={{ ...item.source, label: '등록한 GLB 원본' }} name={item.name} emptyLabel="원본 없음" detail />
      <dl><div><dt>파일</dt><dd>{(item.info.bytes / 1048576).toFixed(2)} MB</dd></div><div><dt>삼각형</dt><dd>{item.info.triangles.toLocaleString()}</dd></div><div><dt>골격</dt><dd>{item.info.rigged ? `${item.info.bone_count}본` : '없음'}</dd></div><div><dt>동작</dt><dd>{item.info.animations.length ? item.info.animations.join(' · ') : '없음'}</dd></div></dl>
      <a href={item.source.url} download={`${item.name}.glb`}>GLB 원본 다운로드</a>
      {item.slot !== 'body' && item.slot !== 'prop' && <fieldset disabled={busy || !!preparing.pending || !!preparing.error}>
        <legend>기준몸에 맞추기</legend><label>기준 몸<select value={selectedBase?.id || ''} onChange={event => setBaseId(event.target.value)}><option value="">선택</option>{bases.map(value => <option key={value.id} value={value.id}>{value.character_name} · {value.id.slice(0, 8)}</option>)}</select></label>
        <button type="button" disabled={!fitReady} onClick={() => void prepare('fit')}>몸에 맞추기 · 기존 골격 연결</button>
        {baseState?.origin === 'uploaded_glb' && <a href={`/?tab=character&mode=body&partsJob=${encodeURIComponent(selectedBase!.id)}`}>기준몸 리깅·피팅 준비</a>}
        {base.error && <p role="alert">{base.error}</p>}
      </fieldset>}
      {item.slot === 'body' && <fieldset disabled={busy || !!preparing.pending || !!preparing.error}><legend>추가 리깅</legend><label>몸 타입<select value={bodyType} onChange={event => setBodyType(event.target.value as 'male' | 'female')}><option value="female">여성형</option><option value="male">남성형</option></select></label><button type="button" onClick={() => void prepare('rig')}>새 리깅 · Meshy 1회</button></fieldset>}
      {preparing.pending && <button disabled={busy || !!preparing.error} onClick={() => void prepare(preparing.pending!.input.action)}>같은 후처리 요청 복구</button>}
      {preparing.error && <p role="alert">{preparing.error}</p>}
      {!!item.operations?.length && <ul className="glb-asset-operations">{item.operations.map(operation => <li key={operation.id}><span>{operation.action === 'fit' ? '몸 맞추기·골격 연결' : '새 리깅'} · {operationLabels[operation.status] || operation.status}</span>{operation.error && <p role="alert">{operation.error}</p>}<button onClick={() => void openOperation(operation.job_id)}>작업 열기</button></li>)}</ul>}
    </div>;
  }
  return <section className="glb-asset-library" aria-label="GLB 에셋 등록">
    <h2>GLB 에셋</h2><div className="glb-asset-inputs"><label>이름<input maxLength={100} placeholder="파일 이름 사용" value={recovery.pending?.input.name ?? name} disabled={busy || !!recovery.pending || !!recovery.error} onChange={event => setName(event.target.value)} /></label>
    {!slot && <label>종류<select value={recovery.pending?.input.slot ?? kind} disabled={busy || !!recovery.pending || !!recovery.error} onChange={event => setKind(event.target.value as GlbAssetSlot)}>{glbAssetSlots.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label>}</div>
    <GlbUpload maxMb={256} disabled={busy || !!recovery.pending || !!recovery.error} onUpload={upload} />
    {recovery.pending && <button disabled={busy || !!recovery.error} onClick={() => void recoverRegistration()}>같은 GLB 등록 요청 복구</button>}
    {(error || recovery.error || listing.error) && <p role="alert">{error || recovery.error || listing.error}</p>}{notice && <p role="status">{notice}</p>}
    {listing.loading && !listing.value && <p>GLB 목록 불러오는 중</p>}
    <div className="glb-asset-list">{visibleItems.map(item => <button key={item.id} aria-pressed={selectedId === item.id} onClick={() => setSelectedId(current => current === item.id ? '' : item.id)}><strong>{item.name}</strong><span>{labels[item.slot]} · {(item.info.bytes / 1048576).toFixed(1)} MB · {item.info.rigged ? `골격 ${item.info.bone_count}본` : '리깅 없음'}</span></button>)}</div>
    {selected && details(selected)}
  </section>;
}
