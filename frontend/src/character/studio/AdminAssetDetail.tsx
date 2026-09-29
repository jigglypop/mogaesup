import { lazy, Suspense, useCallback } from 'react';
import { factoryApi, type BodyProfileState, type FactoryJob, type NativePartsState } from '../factory/api';
import { usePolling } from '../use-polling';
import { isCatalogJobDeleted, studioApi, type Catalog } from './api';
import { AssetModelPreview, type AssetPreviewModel } from './AssetModelPreview';
import { AssetDetailDialog } from './AssetDetailDialog';
import { NativePartRefit } from '../factory/NativePartRefit';
import { AssetProductionStatus } from './AssetProductionStatus';
import { partLabels as labels } from '../factory/parts';
import { expressionNames } from '../texture-expressions';

const MeshyMotion = lazy(() => import('../factory/MeshyMotion').then(m => ({ default: m.MeshyMotion })));
type Polling<T> = ReturnType<typeof usePolling<T>>;
type NativeRead = { jobId: string; parts: NativePartsState } | null;
export type AdminAssetDetailProps = {
  managedAsset: FactoryJob; adminSlot: string; base?: FactoryJob; hidden: boolean; name: (job: FactoryJob) => string;
  catalog: Polling<Catalog>; bodyProfile: Polling<BodyProfileState>; native: Polling<NativeRead>; nativeState?: NativePartsState;
  managedNativeState?: NativePartsState; setManagedNative: Polling<NativeRead>['setValue'];
  showInfo: boolean; onShowInfo: (open: boolean) => void; showMotion: boolean; onShowMotion: (open: boolean) => void;
  busy: boolean; error: string; perform: (action: () => Promise<void>) => Promise<void>;
  onClose: () => void; onDeleted: (asset: { id: string; slot: string; name: string }) => void;
  onOpenProduction: (asset: FactoryJob, slot: string) => void; onCompose: (id: string) => void;
};

// Stays mounted while an asset is selected in the admin tab so its reads survive the compose dialog.
export function AdminAssetDetail({ managedAsset, adminSlot, base, hidden, name, catalog, bodyProfile, native, nativeState, managedNativeState, setManagedNative,
  showInfo, onShowInfo, showMotion, onShowMotion, busy, error, perform, onClose, onDeleted, onOpenProduction, onCompose }: AdminAssetDetailProps) {
  const managedSlot = adminSlot || managedAsset.requested_slots?.[0] || 'body';
  const managedDeleted = isCatalogJobDeleted(managedAsset, catalog.value) || !!catalog.value?.parts?.[`${managedAsset.id}:${managedSlot}`]?.deleted;
  const managedNativeDisplayed = managedNativeState?.preview?.status === 'review_required' ? managedNativeState.preview : managedNativeState;
  const hasManagedModel = managedNativeDisplayed?.artifacts?.some(artifact => artifact.name.endsWith('.glb'));
  const managedStoredArtifacts = hasManagedModel ? managedNativeDisplayed!.artifacts : managedAsset.assembly_artifacts || [];
  const managedStoredVersion = hasManagedModel ? managedNativeDisplayed!.version : managedAsset.assembly_version || '';
  const readManagedMotion = useCallback(async (signal: AbortSignal) => showInfo ? { jobId: managedAsset.id, motion: await factoryApi.meshy(managedAsset.id, signal) } : null, [managedAsset.id, showInfo]);
  const managedMotion = usePolling(readManagedMotion, 10000);
  const managedMotionState = managedMotion.value?.jobId === managedAsset.id ? managedMotion.value?.motion : undefined;
  const readManagedOutfit = useCallback(async (signal: AbortSignal) => showInfo && managedNativeDisplayed?.version
    ? { jobId: managedAsset.id, version: managedNativeDisplayed.version, outfit: await factoryApi.nativeOutfit(managedAsset.id, managedNativeDisplayed.version, signal) } : null,
  [managedAsset.id, managedNativeDisplayed?.version, showInfo]);
  const managedOutfit = usePolling(readManagedOutfit, 15000);
  const managedOutfitState = managedOutfit.value?.jobId === managedAsset.id && managedOutfit.value?.version === managedNativeDisplayed?.version ? managedOutfit.value?.outfit : undefined;
  const readManagedExpressions = useCallback(async (signal: AbortSignal) => showInfo && managedNativeDisplayed?.version
    ? { jobId: managedAsset.id, version: managedNativeDisplayed.version, library: await studioApi.expressions(managedAsset.id, managedNativeDisplayed.version, signal) } : null,
  [managedAsset.id, managedNativeDisplayed?.version, showInfo]);
  const managedExpressions = usePolling(readManagedExpressions, 15000);
  const managedExpressionState = managedExpressions.value?.jobId === managedAsset.id && managedExpressions.value?.version === managedNativeDisplayed?.version ? managedExpressions.value?.library : undefined;
  if (!base || hidden) return null;
  const runtime = nativeState?.parts.reduce((total, part) => ({
    source: total.source + (part.runtime_budget?.source_triangles || 0),
    optimized: total.optimized + (part.runtime_budget?.runtime_triangles || 0),
    target: total.target + (part.runtime_budget?.target_triangles || 0),
    textures: total.textures + (part.runtime_budget?.resized_textures || 0),
  }), { source: 0, optimized: 0, target: 0, textures: 0 });
  const managedGlbs = [...(managedAsset.artifacts || []), ...managedStoredArtifacts]
    .filter(artifact => artifact.name.endsWith('.glb'))
    .filter((artifact, index, items) => items.findIndex(item => item.name === artifact.name && item.url === artifact.url) === index);
  const hasManagedSlotModel = managedGlbs.some(artifact => artifact.name === `${managedSlot}.glb` || artifact.name === `generated-${managedSlot}.glb`);
  const managedModelLabel = (artifact: { name: string }, stored: boolean) => {
    if (!stored) {
      const slot = artifact.name.replace(/^generated-/, '').replace(/\.glb$/, '');
      return managedAsset.input_kind === 'glb' ? '등록한 GLB 원본' : `${labels[slot] || slot} 원본 · 피팅 전`;
    }
    if (artifact.name === 'model.glb') return '전체 조립 저장본';
    if (artifact.name === 'body.glb') return '기본 몸 저장본';
    const slot = artifact.name.replace(/\.glb$/, '');
    return `${labels[slot] || slot} 피팅 저장본`;
  };
  const managedModels: AssetPreviewModel[] = [
    ...managedStoredArtifacts.filter(artifact => artifact.name.endsWith('.glb'))
      .sort((a, b) => (a.name === `${managedSlot}.glb` ? 0 : a.name === 'model.glb' ? 1 : 2) - (b.name === `${managedSlot}.glb` ? 0 : b.name === 'model.glb' ? 1 : 2))
      .map(artifact => ({ ...artifact, name: managedModelLabel(artifact, true), label: managedModelLabel(artifact, true) })),
    ...(managedAsset.artifacts || []).filter(artifact => artifact.name.endsWith('.glb'))
      .sort((a, b) => Number(b.name === `generated-${managedSlot}.glb`) - Number(a.name === `generated-${managedSlot}.glb`))
      .map(artifact => ({ ...artifact, name: managedModelLabel(artifact, false), label: managedModelLabel(artifact, false) })),
  ].filter((artifact, index, items) => items.findIndex(item => item.url === artifact.url) === index);
  const managedImage = [
    `${managedSlot}-front.png`, `${managedSlot}-image.png`,
    'front.png', 'canonical-reference.png', 'reference.png', 'body-front.png',
  ].map(file => managedAsset.artifacts.find(artifact => artifact.name === file)).find(Boolean);
  return <AssetDetailDialog title={name(managedAsset)} onClose={onClose}><section id="admin-selection">
    <div className="admin-inspection-toolbar"><AssetProductionStatus job={managedAsset} slot={managedSlot} hasModel={hasManagedSlotModel} hasAssembly={managedStoredArtifacts.some(item => item.name === `${managedSlot}.glb`)} />{!managedDeleted && <button className="asset-delete" disabled={busy || !catalog.value} onClick={() => void perform(async () => {
      catalog.setValue(await studioApi.savePartMetadata(managedAsset.id, managedSlot, { deleted: true }, catalog.value!.revision));
      onDeleted({ id: managedAsset.id, slot: managedSlot, name: name(managedAsset) });
    })}>{busy ? '처리 중' : '삭제'}</button>}</div>{error && <p className="workspace-error" role="alert">{error}</p>}
    <div className="admin-asset-detail">
      <AssetModelPreview key={`${managedAsset.id}:${managedSlot}:${managedStoredVersion}`} models={managedModels} image={managedImage} name={name(managedAsset)} emptyLabel="저장된 3D 파일 없음" detail autoLoad={hasManagedSlotModel} />
      <div className="admin-asset-data">
      {!managedDeleted && <NativePartRefit key={managedAsset.id} jobId={managedAsset.id} state={managedNativeState} slot={managedSlot}
        disabled={busy || !!managedAsset.character_flow?.busy} onChange={value => {
          if (managedAsset.id === base?.id) native.setValue({ jobId: managedAsset.id, parts: value });
          else setManagedNative({ jobId: managedAsset.id, parts: value });
        }} />}
      <details key={managedAsset.id} className="admin-record" onToggle={event => onShowInfo(event.currentTarget.open)}><summary>작업·파일 정보</summary><dl>
        <div><dt>구분</dt><dd>{managedAsset.base_job_id ? managedAsset.requested_slots?.map(slot => labels[slot] || slot).join(', ') || '파츠' : '기본 몸'}</dd></div>
        <div><dt>작업</dt><dd>{managedAsset.id}</dd></div>
        {managedAsset.base_job_id && <div><dt>기준 몸</dt><dd>{managedAsset.base_job_id}{managedAsset.base_version ? ` · ${managedAsset.base_version}` : ''}</dd></div>}
        <div><dt>조립 버전</dt><dd>{managedNativeDisplayed?.version || managedAsset.assembly_version || '저장 전'}{managedNativeState?.preview === managedNativeDisplayed ? ' · 피팅 미리보기' : ''}</dd></div>
        <div><dt>피팅 규격</dt><dd>{managedNativeDisplayed?.fitting_revision || '기록 없음'}{managedNativeDisplayed?.fit_update_available ? ' · 새 규격 적용 가능' : ''}</dd></div>
        <div><dt>리깅</dt><dd>{managedNativeDisplayed?.rigged === false ? '없음' : managedNativeDisplayed?.bone_count ? `본 ${managedNativeDisplayed.bone_count}개` : '기록 없음'}{managedNativeDisplayed?.origin ? ` · ${managedNativeDisplayed.origin}` : ''}</dd></div>
        <div><dt>동작</dt><dd>{managedMotionState?.clips.length ? managedMotionState.clips.map(clip => clip.slot).join(', ') : managedMotion.loading ? '확인 중' : managedMotion.error ? '조회 실패' : '저장된 동작 없음'}</dd></div>
        <div><dt>착용</dt><dd>{managedOutfitState?.slots.length ? managedOutfitState.slots.map(slot => labels[slot] || slot).join(', ') : managedOutfit.loading ? '확인 중' : managedOutfit.error ? '조회 실패' : '저장된 파츠 없음'}</dd></div>
        <div><dt>헤어 색상</dt><dd>{managedOutfitState?.hair_color ? <><span className="admin-hair-color" style={{ background: managedOutfitState.hair_color }} />{managedOutfitState.hair_color}</> : managedOutfit.loading ? '확인 중' : '원본 색상'}</dd></div>
        <div><dt>표정</dt><dd>{managedExpressionState?.selected ? expressionNames[managedExpressionState.items.find(item => item.id === managedExpressionState.selected)?.name || 'neutral'] : managedExpressions.loading ? '확인 중' : managedExpressions.error ? '조회 실패' : '기본 표정'}</dd></div>
        <div><dt>상태</dt><dd>{managedNativeDisplayed?.status || managedAsset.character_flow?.stage || managedAsset.status}</dd></div>
        <div><dt>생성 시각</dt><dd>{new Date(managedAsset.created_at).toLocaleString()}</dd></div>
        {managedAsset.technical?.file_bytes && <div><dt>원본 파일</dt><dd>{managedAsset.technical.file_bytes.toLocaleString()} bytes</dd></div>}
        {managedAsset.source_sha256 && <div><dt>입력 SHA</dt><dd>{managedAsset.source_sha256}</dd></div>}
      </dl></details>
      <div className="admin-image-views">{(['front','back','side','opposite'] as const).map(view => {
        const artifact = managedAsset.artifacts.find(item => item.name === `${managedSlot}-${view}.png`);
        const label = { front: '정면', back: '후면', side: '측면', opposite: '반대 측면' }[view];
        return artifact && <a key={view} href={artifact.url} target="_blank" rel="noreferrer"><img src={artifact.url} alt={`${name(managedAsset)} ${label}`} /><span>{label}</span></a>;
      })}</div>
      <div className="admin-asset-actions"><button onClick={() => onOpenProduction(managedAsset, managedSlot)}>생성 작업 열기</button>{managedNativeDisplayed?.version && <button onClick={() => onCompose(managedAsset.id)}>착용·조합</button>}</div>
      {managedAsset.id === base.id && nativeState?.origin !== 'uploaded_glb' && <button disabled={busy || !nativeState?.version || !bodyProfile.value || (bodyProfile.value.body?.job_id === base.id && bodyProfile.value.body.version === nativeState.version)} onClick={() => void perform(async () => { bodyProfile.setValue(await factoryApi.saveBodyProfile(base.id, nativeState!.version!, bodyProfile.value!.revision)); })}>{bodyProfile.value?.body?.job_id === base.id ? '공통 기본 몸' : '공통 기본 몸으로 지정'}</button>}
      </div>
    </div>
    <details className="admin-record"><summary>이름·보관·다운로드</summary>
    <form key={`${managedAsset.id}:${catalog.value?.revision}`} onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void perform(async () => { catalog.setValue(await studioApi.saveMetadata(managedAsset.id, String(data.get('name')), data.get('archived') === 'on', catalog.value!.revision)); }); }}><label>이름<input name="name" required maxLength={80} defaultValue={catalog.value?.items[managedAsset.id]?.name || managedAsset.part_name || managedAsset.character_name} /></label><label className="slot-choice"><input type="checkbox" name="archived" defaultChecked={catalog.value?.items[managedAsset.id]?.archived || false} />보관</label><button disabled={busy || !catalog.value}>저장</button></form>
    <div className="artifact-grid">{managedGlbs.map(a => <a key={`${a.name}:${a.url}`} href={a.url} download>{managedModelLabel(a, !a.name.startsWith('generated-'))}</a>)}</div></details>
  </section>{managedAsset.id === base.id && <details className="admin-record base-motion-panel" open={showMotion} onToggle={event => onShowMotion(event.currentTarget.open)}><summary>기본 몸 동작</summary>{showMotion && <>
    {runtime && runtime.optimized > 0 && <dl className="runtime-budget"><div><dt>런타임 삼각형</dt><dd>{runtime.optimized.toLocaleString()}</dd></div><div><dt>원본 삼각형</dt><dd>{runtime.source.toLocaleString()}</dd></div><div><dt>파츠 예산 합계</dt><dd>{runtime.target.toLocaleString()}</dd></div><div><dt>축소 텍스쳐</dt><dd>{runtime.textures.toLocaleString()}</dd></div></dl>}
    <button disabled={busy || !nativeState?.version || ['accepted', 'running'].includes(nativeState.status) || !!base.character_flow?.busy} onClick={() => void perform(async () => { native.setValue({ jobId: base.id, parts: await factoryApi.assemble(base.id, true) }); })}>기본 자세 정렬 · 새 버전 저장</button>
    <Suspense fallback={<p>동작 불러오는 중</p>}><MeshyMotion key={base.id} jobId={base.id} visibleSlots={['idle', 'walk', 'run', 'jump', 'fall']} onRigRecovery={() => void native.refresh()} /></Suspense>
  </>}</details>}</AssetDetailDialog>;
}
