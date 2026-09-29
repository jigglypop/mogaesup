import { useRef, useState } from 'react';
import { ApiError } from '../api';
import type { FactoryJob, NativePartsState } from '../factory/api';
import { partLabels, variantSlots } from '../factory/parts';
import { isCatalogJobDeleted, studioApi, type Catalog, type PartMetadata } from './api';
import { PartFitting } from './PartFitting';
import { AssetModelPreview } from './AssetModelPreview';
import { AssetProductionStatus } from './AssetProductionStatus';

const assetSlots = ['body', ...variantSlots, 'hairFront', 'hairBack', 'head'];
const partCategories = [
  ['body', '기본몸'], ['hair', '헤어'], ['all', '전체'], ['headwear', '머리·장식'], ['top', '상의'],
  ['bottom', '하의'], ['shoes', '신발'], ['equipment', '장비'],
] as const;

function categoryOf(slot: string) {
  if (['hair', 'hairFront', 'hairBack'].includes(slot)) return 'hair';
  if (['head', 'hat', 'glasses'].includes(slot)) return 'headwear';
  if (['weapon', 'tool'].includes(slot)) return 'equipment';
  return slot;
}

type Props = {
  jobs: FactoryJob[];
  loading?: boolean;
  catalog?: Catalog;
  nativeJobId?: string;
  nativeState?: NativePartsState;
  onOpen: (job: FactoryJob, slot?: string) => void;
  onCompose: (job: FactoryJob) => void;
  onCatalogChange: (catalog: Catalog) => void;
  onRefresh: () => Promise<void>;
};

export function AssetGallery({ jobs, loading, catalog, nativeJobId, nativeState, onOpen, onCompose, onCatalogChange, onRefresh }: Props) {
  const [view, setView] = useState<'characters' | 'parts'>('parts');
  const [filter, setFilter] = useState<(typeof partCategories)[number][0]>('body');
  const [characterFilter, setCharacterFilter] = useState('all');
  const [trash, setTrash] = useState(false), [search, setSearch] = useState(''), [visible, setVisible] = useState(24);
  const [editing, setEditing] = useState<{ key: string; name: string; revision: string }>();
  const [fitting, setFitting] = useState<{ key: string; jobId: string; slot: 'top' | 'bottom'; label: string; rawUrl?: string }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [deletedItem, setDeletedItem] = useState<{ job: FactoryJob; slot?: string; scope?: 'character' | 'version' }>();
  const locked = useRef(false);
  const characterKey = (job: FactoryJob) => job.character_id || job.id;
  const characterDeleted = (job: FactoryJob) => !!catalog?.characters?.[characterKey(job)]?.deleted;
  const jobDeleted = (job: FactoryJob) => isCatalogJobDeleted(job, catalog);
  const byCharacter = new Map<string, FactoryJob>();
  for (const job of [...jobs].sort((a, b) => Number(jobDeleted(b) === trash) - Number(jobDeleted(a) === trash) || b.created_at.localeCompare(a.created_at))) {
    const existing = byCharacter.get(characterKey(job));
    if (!existing || (!job.base_job_id && !!existing.base_job_id)) byCharacter.set(characterKey(job), job);
  }
  const rootFor = (job: FactoryJob) => byCharacter.get(characterKey(job)) || job;
  const characterName = (job: FactoryJob) => {
    const root = rootFor(job);
    return catalog?.parts?.[`${root.id}:body`]?.name || catalog?.items[root.id]?.name || root.character_name;
  };
  const items = jobs.flatMap(job => assetSlots.flatMap(slot => {
    if (job.base_job_id && job.requested_slots && !job.requested_slots.includes(slot)) return [];
    const image = job.artifacts.find(artifact => [`${slot}-front.png`, `${slot}-image.png`].includes(artifact.name));
    const generatedModel = job.artifacts.find(artifact => [`generated-${slot}.glb`, `${slot}.glb`].includes(artifact.name));
    const nativeModel = job.assembly_artifacts?.find(artifact => artifact.name === `${slot}.glb`)
      || (nativeJobId === job.id && nativeState?.status === 'review_required' && nativeState.version === job.assembly_version
        ? nativeState.artifacts.find(artifact => artifact.name === `${slot}.glb`) : undefined);
    if (!image && !generatedModel && !nativeModel && !job.parts?.some(part => part.slot === slot)) return [];
    const key = `${job.id}:${slot}`, metadata = catalog?.parts?.[key], label = partLabels[slot] || slot;
    const name = metadata?.name || catalog?.items[job.id]?.name || job.part_name || `${job.character_name} · ${label}`;
    return [{ key, job, rootId: characterKey(job), slot, category: categoryOf(slot), label, name,
      deleted: !!metadata?.deleted || jobDeleted(job), image, generatedModel, nativeModel }];
  }));
  const roots = [...byCharacter.values()].filter(root => items.some(item => item.rootId === characterKey(root) && item.deleted === trash));
  const categories = partCategories.filter(([key]) => ['all', 'body', 'hair'].includes(key) || key === filter || items.some(item => item.deleted === trash && item.category === key));
  const query = search.trim().toLocaleLowerCase();
  const matchesQuery = (item: (typeof items)[number]) => !query
    || `${item.name} ${item.label} ${characterName(item.job)} ${item.job.id}`.toLocaleLowerCase().includes(query);
  const filtered = items.filter(item => item.deleted === trash
    && (filter === 'all' || item.category === filter)
    && (characterFilter === 'all' || item.rootId === characterFilter) && matchesQuery(item))
    .sort((a, b) => Number(!!(b.nativeModel || b.generatedModel)) - Number(!!(a.nativeModel || a.generatedModel)));
  const shown = filtered.slice(0, visible);
  const characterGroups = roots.flatMap(root => {
    const rootMatches = !query || `${characterName(root)} ${root.character_name} ${root.id}`.toLocaleLowerCase().includes(query);
    const availableParts = items.filter(item => item.rootId === characterKey(root) && item.deleted === trash);
    const parts = rootMatches ? availableParts : availableParts.filter(matchesQuery);
    const versions = jobs.filter(job => characterKey(job) === characterKey(root))
      .filter(job => jobDeleted(job) === trash)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (!parts.length && (!rootMatches || !versions.length)) return [];
    const preview = ['front.png', 'canonical-reference.png', 'reference.png', 'body-front.png']
      .map(name => root.artifacts.find(artifact => artifact.name === name)).find(Boolean)
      || parts.find(item => item.slot === 'body')?.image || parts[0]?.image;
    const assembledVersion = versions.find(version => version.assembly_artifacts?.some(artifact => artifact.name === 'model.glb')) || root;
    const assembly = assembledVersion.assembly_artifacts?.find(artifact => artifact.name === 'model.glb')
      || (nativeJobId === assembledVersion.id && nativeState?.status === 'review_required' && nativeState.version === assembledVersion.assembly_version
        ? nativeState.artifacts.find(artifact => artifact.name === 'model.glb') : undefined);
    const generated = root.artifacts.find(artifact => artifact.name === 'generated-body.glb');
    const model = assembly ? { ...assembly, label: '조립 저장본' }
      : generated ? { ...generated, label: '기본몸 생성본 · 조립 전' } : undefined;
    return [{ root, parts, versions, preview, assembly, assembledVersion, model }];
  });

  async function save(jobId: string, slot: string, changes: PartMetadata, revision = catalog?.revision) {
    if (locked.current || !revision) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try {
      onCatalogChange(await studioApi.savePartMetadata(jobId, slot, changes, revision));
      setEditing(undefined);
      if (changes.deleted === true) setDeletedItem({ job: jobs.find(job => job.id === jobId)!, slot });
      else if (changes.deleted === false) setDeletedItem(undefined);
      setNotice(changes.deleted === true ? '휴지통으로 이동했습니다.' : changes.deleted === false ? '복원했습니다.' : '이름을 저장했습니다.');
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'revision_conflict' ? '목록이 변경되었습니다. 취소 후 다시 편집해 주세요.' : (e as Error).message);
      await onRefresh();
    } finally { locked.current = false; setBusy(false); }
  }

  async function setVisibility(job: FactoryJob, scope: 'character' | 'version', deleted: boolean) {
    if (locked.current || !catalog) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try {
      onCatalogChange(await studioApi.setVisibility(job.id, scope, deleted, catalog.revision));
      setEditing(undefined);
      setDeletedItem(deleted ? { job, scope } : undefined);
      setNotice(`${scope === 'character' ? '캐릭터 전체' : '조합 버전'}를 ${deleted ? '휴지통으로 이동했습니다.' : '복원했습니다.'}`);
    } catch (reason) {
      setError((reason as Error).message); await onRefresh();
    } finally { locked.current = false; setBusy(false); }
  }

  function openFitting(jobId: string, slot: 'top' | 'bottom') {
    const item = items.find(candidate => candidate.job.id === jobId && candidate.slot === slot);
    setFitting({ key: `${jobId}:${slot}`, jobId, slot, label: partLabels[slot], rawUrl: item?.image?.url });
  }

  function assetCard(item: (typeof items)[number], compact = false) {
    const { key, job, slot, label, name, image, generatedModel, nativeModel } = item;
    return <article className={`asset-gallery-card ${compact ? 'compact' : ''}`} key={key}>
      <AssetModelPreview model={nativeModel ? { ...nativeModel, label: slot === 'body' ? '기본몸 저장본' : '피팅 저장본' }
        : generatedModel ? { ...generatedModel, label: job.input_kind === 'glb' ? '등록한 GLB 원본' : '파츠 생성본 · 조립 전' } : undefined}
        image={image} name={name} emptyLabel={image ? '3D 생성 전' : '아직 저장된 결과 없음'} />
      <AssetProductionStatus job={job} slot={slot} hasModel={!!(nativeModel || generatedModel)} hasAssembly={!!nativeModel} compact />
      <div className="asset-gallery-info"><strong title={name}>{name}</strong><span>{slot === 'body' ? label : characterName(job)}</span></div>
      <div className="asset-gallery-actions"><button className="asset-open" onClick={() => onOpen(job, slot)}>크게 보기</button>{!trash && nativeModel && <button onClick={() => onCompose(job)}>착용·조합</button>}{jobDeleted(job)
        ? <button disabled={busy || !catalog} onClick={() => void setVisibility(job, characterDeleted(job) ? 'character' : 'version', false)}>{characterDeleted(job) ? '캐릭터 복원' : '조합 복원'}</button>
        : <button type="button" className={trash ? '' : 'asset-delete'} title={trash ? '휴지통에서 복원' : '휴지통으로 이동'} aria-label={`${name} ${trash ? '복원' : '삭제'}`} disabled={busy || !catalog} onClick={() => void save(job.id, slot, { deleted: !trash })}>{trash ? '복원' : '삭제'}</button>}</div>
      <details className="asset-card-tools"><summary>관리·다운로드</summary>
      {editing?.key === key ? <form className="asset-gallery-edit" onSubmit={event => { event.preventDefault(); void save(job.id, slot, { name: editing.name.trim() }, editing.revision); }}>
        <label>파츠 이름<input autoFocus required maxLength={80} value={editing.name} disabled={busy} onChange={event => setEditing({ ...editing, name: event.target.value })} onKeyDown={event => { if (event.key === 'Escape' && !busy) setEditing(undefined); }} /></label>
        <div><button disabled={busy || !editing.name.trim()}>저장</button><button type="button" disabled={busy} onClick={() => setEditing(undefined)}>취소</button></div>
      </form> : <div className="asset-gallery-actions"><button disabled={busy} onClick={() => { setEditing({ key, name, revision: catalog!.revision }); setError(''); setNotice(''); }}>이름 수정</button></div>}
      <div className="asset-gallery-actions">{(slot === 'top' || slot === 'bottom') && generatedModel && <button onClick={() => openFitting(job.id, slot)}>피팅</button>}{image && <a href={image.url} target="_blank" rel="noreferrer">이미지</a>}{generatedModel && <a href={generatedModel.url} download>원본 GLB</a>}{nativeModel && <a href={nativeModel.url} download>피팅 GLB</a>}</div>
      <small className="asset-card-date">{new Date(job.created_at).toLocaleString()} · {job.id.slice(0, 8)}</small>
      </details>
    </article>;
  }

  return <section className="asset-gallery" aria-labelledby="asset-gallery-title" aria-busy={busy}>
    <div className="asset-gallery-heading"><h2 id="asset-gallery-title">저장된 에셋</h2>
      <div className="asset-gallery-view-switch" role="group" aria-label="라이브러리 보기"><button aria-pressed={view === 'parts'} onClick={() => setView('parts')}>파츠 목록</button><button aria-pressed={view === 'characters'} onClick={() => setView('characters')}>캐릭터 조합</button></div>
    </div>
    {view === 'parts' && <div className="asset-gallery-filters asset-category-tabs" role="group" aria-label="파츠 분류">{categories.map(([key, label]) => <button key={key} aria-pressed={filter === key} onClick={() => { setFilter(key); setVisible(24); }}>{label}<span>{items.filter(item => item.deleted === trash && (key === 'all' || item.category === key)).length}</span></button>)}</div>}
    <div className="asset-gallery-toolbar">
      <label>검색<input type="search" value={search} onChange={event => { setSearch(event.target.value); setVisible(24); }} placeholder="캐릭터 · 파츠" /></label>
      {view === 'parts' && <label>캐릭터<select value={characterFilter} onChange={event => { setCharacterFilter(event.target.value); setVisible(24); }}><option value="all">전체 캐릭터</option>{roots.map(root => <option key={root.id} value={characterKey(root)}>{characterName(root)}</option>)}</select></label>}
      <div className="asset-gallery-filters" role="group" aria-label="보관 위치"><button aria-pressed={!trash} onClick={() => { setTrash(false); setCharacterFilter('all'); setVisible(24); }}>갤러리</button><button aria-pressed={trash} onClick={() => { setTrash(true); setCharacterFilter('all'); setVisible(24); }}>휴지통 · {items.filter(item => item.deleted).length}</button></div>
      <span>{view === 'characters' ? characterGroups.length : filtered.length}개</span>
    </div>
    {error && <p role="alert">{error}</p>}{notice && <div className="asset-delete-notice" role="status"><span>{notice}</span>{deletedItem && <button disabled={busy} onClick={() => deletedItem.slot ? void save(deletedItem.job.id, deletedItem.slot, { deleted: false }) : void setVisibility(deletedItem.job, deletedItem.scope!, false)}>삭제 취소</button>}</div>}
    {fitting && <PartFitting key={fitting.key} jobId={fitting.jobId} slot={fitting.slot} label={fitting.label} rawUrl={fitting.rawUrl} onClose={() => setFitting(undefined)} onPendingSlot={pendingSlot => openFitting(fitting.jobId, pendingSlot)} />}
    {(!catalog || loading) ? <p className="asset-gallery-empty">관리 목록 불러오는 중…</p> : view === 'characters' ? characterGroups.length ? <div className="asset-character-grid">{characterGroups.map(({ root, parts, versions, preview, assembly, assembledVersion, model }) => <article className="asset-character-card" key={root.id}>
      <AssetModelPreview model={model} image={preview} name={characterName(root)} emptyLabel="아직 저장된 결과 없음" />
      <AssetProductionStatus job={assembly ? assembledVersion : root} hasModel={!!model} hasAssembly={!!assembly} />
      <div className="asset-character-heading"><div><strong>{characterName(root)}</strong><small>{versions.length}개 버전 · {parts.length}개 파츠</small></div><button onClick={() => onOpen(assembly ? assembledVersion : root)}>캐릭터 열기</button></div>
      <div className="asset-character-actions">{!trash && assembly && <button onClick={() => onCompose(assembledVersion)}>조합·표정 편집</button>}{(!trash || characterDeleted(root)) && <button className={trash ? '' : 'asset-delete'} disabled={busy} onClick={() => void setVisibility(root, 'character', !trash)}>{trash ? '캐릭터 전체 복원' : '캐릭터 전체 삭제'}</button>}</div>
      <details><summary>저장 버전 · {versions.length}</summary><div className="asset-character-versions">{versions.map(version => <div className="asset-character-version" key={version.id}><button onClick={() => onOpen(version)}>{version.part_name || (version.base_job_id ? version.requested_slots?.map(slot => partLabels[slot] || slot).join(', ') || '파츠 조합' : '기본몸 조합')}<small>{new Date(version.created_at).toLocaleString()}</small></button>{!trash && version.assembly_version && <button onClick={() => onCompose(version)}>조합 편집·저장</button>}{!characterDeleted(version) && <button className={trash ? '' : 'asset-delete'} disabled={busy} onClick={() => void setVisibility(version, 'version', !trash)}>{trash ? '조합 복원' : '조합 삭제'}</button>}</div>)}</div></details>
      <details><summary>연결 파츠 · {parts.length}</summary><div className="asset-character-parts">{parts.map(item => assetCard(item, true))}</div></details>
    </article>)}</div> : <p className="asset-gallery-empty">{query ? '검색 결과가 없습니다.' : trash ? '삭제한 에셋이 없습니다.' : '저장된 캐릭터가 없습니다.'}</p>
      : filtered.length ? <><div className={`asset-gallery-grid category-${filter}`}>{shown.map(item => assetCard(item))}</div>{visible < filtered.length && <button className="asset-gallery-more" onClick={() => setVisible(count => count + 24)}>더 보기 · {filtered.length-visible}개</button>}</>
        : <p className="asset-gallery-empty">{query ? '검색 결과가 없습니다.' : trash ? '삭제한 에셋이 없습니다.' : '이 분류에 저장된 파츠가 없습니다.'}</p>}
  </section>;
}
