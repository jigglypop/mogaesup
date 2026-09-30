import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { factoryApi, type FactoryJob } from '../factory/api';
import { NativeAssembly } from '../factory/NativeAssembly';
import { usePolling } from '../use-polling';
import { isCatalogJobDeleted, studioApi } from './api';
import { AssetGallery } from './AssetGallery';
import { AssetDetailDialog } from './AssetDetailDialog';
import { AdminAssetDetail } from './AdminAssetDetail';
import { variantSlots } from '../factory/parts';
import { SinglePart } from './SinglePart';
import { GlbAssetLibrary } from './GlbAssetLibrary';
import '../factory/character-factory.css';
import './workspace.css';

const PhotoFactory = lazy(() => import('../factory/CharacterFactory').then(m => ({ default: m.CharacterFactory })));
const BaseBodies = lazy(() => import('./BaseBodies'));
const Wardrobe = lazy(() => import('./Wardrobe'));
const Animals = lazy(() => import('./Animals'));
const Textures = lazy(() => import('./Textures'));
const Generations = lazy(() => import('./Generations'));
const Emoticons = lazy(() => import('./Emoticons'));
const Prompts = lazy(() => import('./Prompts'));
const tabs = { admin: '관리자페이지', animals: '동물', character: '캐릭터', props: '기물', textures: '기본 바닥 타일', emoticons: '2D 이모티콘', prompts: '프롬프트 관리' };

export function Workspace() {
  const initial = new URLSearchParams(location.search);
  const [tab, setTab] = useState<keyof typeof tabs>((initial.get('tab') || '') in tabs ? initial.get('tab') as keyof typeof tabs : 'character');
  const [characterMode, setCharacterMode] = useState<'body' | 'photo' | 'parts' | 'wardrobe'>(
    (['body', 'parts', 'wardrobe'] as const).find(mode => mode === initial.get('mode')) || 'photo');
  const [partType, setPartType] = useState<(typeof variantSlots)[number]>(variantSlots.find(slot => slot === initial.get('part')) || 'top');
  const [baseId, setBaseId] = useState(initial.get('base') || '');
  const [jobId, setJobId] = useState(initial.get('partsJob') || '');
  const [adminAssetId, setAdminAssetId] = useState(initial.get('asset') || '');
  const [adminSlot, setAdminSlot] = useState('');
  const [showUploads, setShowUploads] = useState(false);
  const [showMotion, setShowMotion] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [deletedAsset, setDeletedAsset] = useState<{ id: string; slot: string; name: string }>();
  const [composeId, setComposeId] = useState('');
  const [textureMode] = useState<'basic' | 'prompt'>('basic');
  // The server refreshes its job snapshot every 10 seconds; child screens share these three reads.
  const jobs = usePolling(factoryApi.list, 10000), catalog = usePolling(studioApi.catalog, 15000), bodyProfile = usePolling(factoryApi.bodyProfile, 15000);
  const candidates = (jobs.value?.jobs || []).filter(j => j.production_mode === 'character_parts').sort((a,b) => b.created_at.localeCompare(a.created_at));
  const baseCandidates = candidates.filter(j => !j.base_job_id);
  const composeJob = candidates.find(j => j.id === composeId && !isCatalogJobDeleted(j, catalog.value));
  const bases = candidates.filter(j => ['complete', 'expressions'].includes(j.character_flow?.stage || '') && j.assembly_origin !== 'uploaded_glb' && !isCatalogJobDeleted(j, catalog.value) && !catalog.value?.items[j.id]?.archived && !catalog.value?.parts?.[`${j.id}:body`]?.deleted);
  const basePool = tab === 'admin' ? baseCandidates : bases;
  // New parts default to the common body so they land in its wardrobe.
  const base = basePool.find(j => j.id === baseId) || (tab === 'admin' ? baseCandidates[0]
    : bases.find(j => j.id === bodyProfile.value?.body?.job_id) || bases.find(j => !j.base_job_id) || bases[0]);
  const baseVariants = base ? candidates.filter(j => j.base_job_id === base.id) : [];
  const managedAsset = candidates.find(j => j.id === adminAssetId);
  const readNative = useCallback(async (signal: AbortSignal) => ((tab === 'character' && characterMode === 'parts') || (tab === 'admin' && adminAssetId === base?.id)) && base ? { jobId: base.id, parts: await factoryApi.nativeParts(base.id, signal) } : null, [base?.id, tab, adminAssetId, characterMode]);
  const native = usePolling(readNative, 10000);
  const nativeState = native.value?.jobId === base?.id ? native.value?.parts : undefined;
  const readManagedNative = useCallback(async (signal: AbortSignal) => tab === 'admin' && managedAsset && managedAsset.id !== base?.id ? { jobId: managedAsset.id, parts: await factoryApi.nativeParts(managedAsset.id, signal) } : null, [base?.id, managedAsset?.id, tab]);
  const managedNative = usePolling(readManagedNative, 10000);
  const managedNativeState = managedAsset?.id === base?.id ? nativeState : managedNative.value?.jobId === managedAsset?.id ? managedNative.value?.parts : undefined;
  const versions = base ? [base, ...baseVariants.filter(item => !catalog.value?.items[item.id]?.archived)] : [];
  const job = versions.find(j => j.id === jobId) || base;
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const locked = useRef(false);
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    query.set('tab', tab);
    if (tab === 'character') query.set('mode', characterMode);
    if (tab === 'character' && characterMode === 'parts') query.set('part', partType);
    if (baseId) query.set('base', baseId); else query.delete('base');
    if (jobId) query.set('partsJob', jobId); else query.delete('partsJob');
    if (tab === 'admin' && adminAssetId) query.set('asset', adminAssetId); else query.delete('asset');
    history.replaceState(null, '', `/?${query}`);
  }, [tab, characterMode, partType, baseId, jobId, adminAssetId]);
  const listJob = useCallback((result: FactoryJob) => {
    jobs.setValue(current => ({ jobs: [result, ...(current?.jobs || []).filter(item => item.id !== result.id)] }));
  }, [jobs.setValue]);
  const receiveJob = useCallback((result: FactoryJob) => {
    setJobId(result.id);
    listJob(result);
  }, [listJob]);
  function openProduction(asset: FactoryJob, slot: string) {
    setAdminAssetId(''); setTab('character');
    if (asset.base_body) { setJobId(asset.id); setCharacterMode('body'); return; }
    if (!asset.base_job_id || (asset.requested_slots?.length || 0) > 1) {
      // A photo character (with or without a chosen base body) opens in the photo screen,
      // which reads its selection from the address when it mounts.
      const query = new URLSearchParams(location.search);
      query.set('photoJob', asset.id); query.set('photoCharacter', asset.character_id);
      history.replaceState(null, '', `${location.pathname}?${query}`);
      setCharacterMode('photo'); return;
    }
    setJobId(asset.id); setBaseId(asset.base_job_id); setCharacterMode('parts');
    if (variantSlots.includes(slot as typeof partType)) setPartType(slot as typeof partType);
  }
  function choosePart(slot: (typeof variantSlots)[number]) {
    setCharacterMode('parts'); setPartType(slot);
  }
  async function perform(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { locked.current = false; setBusy(false); }
  }
  const name = (j: FactoryJob) => catalog.value?.parts?.[`${j.id}:${j.requested_slots?.[0] || 'body'}`]?.name || catalog.value?.items[j.id]?.name || j.part_name || `${j.character_name} · ${new Date(j.created_at).toLocaleString()}`;
  return <div className="character-factory workspace studio-shell">
    <div className="studio-main">
    {(error || jobs.error || catalog.error || bodyProfile.error || native.error || managedNative.error) && <p className="workspace-error" role="alert">{error || jobs.error || catalog.error || bodyProfile.error || native.error || managedNative.error}</p>}
    {tab === 'character' && <>
    {characterMode === 'body' ? <Suspense fallback={<p className="workspace-content">불러오는 중</p>}><BaseBodies selectedJobId={jobId} jobs={candidates.filter(item => !isCatalogJobDeleted(item, catalog.value))} onJob={receiveJob} refreshJobs={jobs.refresh} /></Suspense> : characterMode === 'photo' ? <Suspense fallback={<p className="workspace-content">불러오는 중</p>}><PhotoFactory
      jobs={jobs.value?.jobs || []} jobsLoading={jobs.loading && !jobs.value} jobsError={jobs.error}
      catalog={catalog.value} catalogError={catalog.error} bodyProfile={bodyProfile.value} bodyProfileError={bodyProfile.error}
      onJob={listJob} refreshJobs={jobs.refresh} /></Suspense> : characterMode === 'wardrobe' ? <Suspense fallback={<p className="workspace-content">불러오는 중</p>}><Wardrobe /></Suspense> : <SinglePart slot={partType} onSlotChange={choosePart} bases={bases} base={base} native={nativeState} versions={versions} job={job} name={name} onBaseChange={id => { setBaseId(id); setJobId(''); }} onJobChange={setJobId} onJob={receiveJob} refreshJobs={jobs.refresh} />}</>}
    {tab === 'admin' && <div className="workspace-content admin-library"><div className="workspace-heading"><h1>에셋 관리</h1><div className="admin-heading-actions"><button onClick={() => { setTab('character'); setCharacterMode('body'); }}>기본몸 추가</button><button onClick={() => { setTab('character'); choosePart('hair'); }}>헤어 생성</button><button aria-expanded={showUploads} onClick={() => setShowUploads(value => !value)}>GLB 등록</button></div></div>
        {deletedAsset && <div className="asset-delete-notice" role="status"><span>{deletedAsset.name} · 휴지통으로 이동했습니다.</span><button disabled={busy || !catalog.value} onClick={() => void perform(async () => { catalog.setValue(await studioApi.savePartMetadata(deletedAsset.id, deletedAsset.slot, { deleted: false }, catalog.value!.revision)); setDeletedAsset(undefined); })}>삭제 취소</button></div>}
        {showUploads && <GlbAssetLibrary bases={bases} defaultBaseId={base?.id} onJob={result => { setBaseId(result.base_job_id || result.id); setAdminAssetId(result.id); setAdminSlot(''); receiveJob(result); void jobs.refresh(); }} />}
        <AssetGallery jobs={candidates} loading={jobs.loading && !jobs.value} catalog={catalog.value} onCatalogChange={catalog.setValue} onRefresh={catalog.refresh} nativeJobId={managedAsset?.id} nativeState={managedNativeState} onOpen={(item, slot) => { setBaseId(item.base_job_id || item.id); setAdminAssetId(item.id); setAdminSlot(slot || ''); setJobId(item.id); setShowMotion(false); }} onCompose={item => setComposeId(item.id)} />
        {composeJob && <AssetDetailDialog title={`착용·조합 · ${name(composeJob)}`} onClose={() => setComposeId('')}><NativeAssembly key={composeJob.id} jobId={composeJob.id} simple flow={composeJob.character_flow} /></AssetDetailDialog>}
        {managedAsset && <AdminAssetDetail managedAsset={managedAsset} adminSlot={adminSlot} base={base} hidden={!!composeJob} name={name}
          catalog={catalog} bodyProfile={bodyProfile} native={native} nativeState={nativeState} managedNativeState={managedNativeState} setManagedNative={managedNative.setValue}
          showInfo={showInfo} onShowInfo={setShowInfo} showMotion={showMotion} onShowMotion={setShowMotion} busy={busy} error={error} perform={perform}
          onClose={() => setAdminAssetId('')} onDeleted={asset => { setDeletedAsset(asset); setAdminAssetId(''); }} onOpenProduction={openProduction} onCompose={setComposeId} />}
    </div>}
    {tab === 'textures' && <><Suspense fallback={<p className="workspace-content">불러오는 중</p>}>{textureMode === 'basic' ? <Textures /> : <Generations key="texture" kind="texture" />}</Suspense></>}
    {tab === 'props' && <Suspense fallback={<p className="workspace-content">불러오는 중</p>}><Generations key="prop" kind="prop" /></Suspense>}
    {tab === 'emoticons' && <Suspense fallback={<p className="workspace-content">불러오는 중</p>}><Emoticons /></Suspense>}
    {tab === 'animals' && <Suspense fallback={<p>불러오는 중</p>}><Animals /></Suspense>}
    {tab === 'prompts' && <Suspense fallback={<p className="workspace-content">프롬프트 불러오는 중</p>}><Prompts /></Suspense>}
    </div>
  </div>;
}
