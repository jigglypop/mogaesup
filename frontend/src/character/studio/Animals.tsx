import { useEffect, useId, useRef, useState } from 'react';
import { ModelViewer } from '../viewer';
import { usePolling } from '../use-polling';
import { studioApi, type Animal, type AnimalProgress, type AnimalRegenerateInput, type AnimalStep, type AnimalView } from './api';
import { AssetDetailDialog } from './AssetDetailDialog';
import { AssetModelPreview } from './AssetModelPreview';
import './generations.css';
import './animals.css';

const speciesLabels: Record<Animal['species'], string> = { dog: '강아지' };
const models = [['motions-standard.glb', '표준 골격'], ['walk.glb', 'Tripo 걷기'], ['rigged.glb', 'Tripo 리깅'], ['model.glb', '3D 모델']] as const;
const clipLabels: Record<string, string> = { walk: '걷기', run: '달리기', idle: '대기', bark: '짖기', sit: '앉기', lie: '엎드리기', jump: '점프' };
const clipOrder = Object.keys(clipLabels);
const views = [['reference.png', '원본'], ['front.png', '정면'], ['left.png', '좌측면'], ['back.png', '후면'], ['right.png', '우측면']] as const;
const viewChoices: [AnimalView, string][] = [['front', '정면'], ['left', '좌측면'], ['back', '후면'], ['right', '우측면']];
const viewLabels = Object.fromEntries(viewChoices) as Record<AnimalView, string>;
const stepLabels: Record<AnimalStep, string> = { views: '면 다시 그리기', model: '3D 생성', rig: '표준 골격' };
const statusLabels = { accepted: '접수됨', running: '진행 중', paused: '일시 중지', blocked: '확인 필요', failed: '실패', complete: '완료' } as const;
// Shown until this animal has a recorded Meshy charge of its own.
const MESHY_CREDITS = 30;
const IMAGE_TYPES = ['image/png', 'image/jpeg'];
const MAX_IMAGE_MB = 32;

function summary(animal: Animal) {
  const job = animal.production;
  if (job && ['accepted', 'running'].includes(job.status)) return `${job.step ? stepLabels[job.step] : '다시 만들기'} 중`;
  const { views, model, rig, walk, standard } = animal.stages;
  if (standard?.status === 'complete' || walk?.status === 'complete') return '걷기 완료';
  if (rig?.status === 'complete') return '사족 리깅 완료';
  if (model?.status === 'complete') return '3D 모델 완료';
  if (views?.status === 'complete') return '4면 이미지 완료';
  return '원본';
}

function stageRows(animal: Animal): [string, string][] {
  const { views, model, rig, walk, standard } = animal.stages;
  const rows: [string, string][] = [
    ['4면 이미지', views ? `${views.images}장 · ${views.provider}` : '없음'],
    ['3D 모델', model ? `${model.provider}${model.triangles ? ` · 삼각형 ${model.triangles.toLocaleString()}` : ''}${typeof model.credits === 'number' ? ` · ${model.credits}크레딧` : ''}` : '없음'],
  ];
  if (rig) rows.push(['Tripo 리깅', `${rig.provider}${rig.bones ? ` · 뼈 ${rig.bones}개` : ''}`]);
  if (walk) rows.push(['Tripo 걷기', `${walk.provider}${walk.frames ? ` · ${walk.frames}프레임` : ''}${walk.paws ? ` · 발 접지 ${walk.grounded_paws}/${walk.paws}` : ''}`]);
  if (standard) rows.push(['표준 골격', `${standard.provider}${standard.bones ? ` · 뼈 ${standard.bones}개` : ''}${standard.clips?.length ? ` · 동작 ${standard.clips.length}개` : ''}${standard.paws ? ` · 걷기 발 접지 ${standard.grounded_paws}/${standard.paws}` : ''}`]);
  return rows;
}

function progressLabel(progress?: AnimalProgress | null) {
  if (!progress) return '';
  if (typeof progress.percent === 'number') return ` · ${progress.percent}%`;
  if (typeof progress.done === 'number' && progress.total) {
    return progress.current ? ` · ${viewLabels[progress.current]} ${progress.done + 1}/${progress.total}` : ` · ${progress.done}/${progress.total}장`;
  }
  return '';
}

// Files keep their names when regenerated; the content hash makes viewers and images reload.
const artifact = (animal: Animal, name: string) => {
  const item = animal.artifacts.find(entry => entry.name === name);
  return item && { ...item, url: `${item.url}?v=${item.sha256.slice(0, 12)}` };
};

function CreateAnimal({ onCreated }: { onCreated(animal: Animal): void }) {
  const id = useId();
  const [name, setName] = useState(''), [species, setSpecies] = useState<Animal['species']>('dog');
  const [file, setFile] = useState<File>(), [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [dragging, setDragging] = useState(false);
  const [, setSettled] = useState(0);
  const locked = useRef(false), dragDepth = useRef(0);
  const recovery = studioApi.animalCreateRecovery(), pending = recovery.pending;
  const unavailable = busy || !!pending || !!recovery.error;

  useEffect(() => {
    if (!file) { setPreview(''); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function select(files: File[]) {
    if (unavailable) return;
    setError('');
    const next = files[0];
    if (!next) return;
    const problem = files.length !== 1 ? '그림을 하나만 선택해 주세요.'
      : !IMAGE_TYPES.includes(next.type) && !/\.(png|jpe?g)$/i.test(next.name) ? 'PNG 또는 JPEG 그림을 선택해 주세요.'
      : next.size === 0 ? '빈 파일은 올릴 수 없습니다.'
      : next.size > MAX_IMAGE_MB * 1024 * 1024 ? `그림은 ${MAX_IMAGE_MB}MB 이내로 올려 주세요.` : '';
    if (problem) { setError(problem); return; }
    setFile(next);
    if (!name.trim()) setName(next.name.replace(/\.[^.]+$/, '').slice(0, 80));
  }

  async function submit() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      let input = studioApi.animalCreateRecovery().pending?.input;
      if (!input) {
        if (!file || !name.trim()) return;
        const reference = await studioApi.uploadAnimalReference(file);
        input = { name: name.trim(), species, reference: reference.id };
      }
      const animal = await studioApi.createAnimal(input);
      setName(''); setFile(undefined);
      onCreated(animal);
    } catch (cause) { setError((cause as Error).message); }
    finally { locked.current = false; setBusy(false); setSettled(count => count + 1); }
  }

  return <section className="animal-create" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>동물 추가</h2>
    <div className="animal-create-row">
      {/* The file input inside is the one control: Tab reaches it, and a paste while it has focus or a drop selects too. */}
      <div className="animal-create-drop" data-dragging={dragging && !unavailable} data-disabled={unavailable}
        onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); select(files); } }}
        onDragEnter={event => { event.preventDefault(); if (!unavailable) { dragDepth.current++; setDragging(true); } }}
        onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = unavailable ? 'none' : 'copy'; }}
        onDragLeave={event => { event.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
        onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); select(Array.from(event.dataTransfer.files)); }}>
        <label htmlFor={`${id}-file`}>
          {preview ? <img src={preview} alt="" /> : <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></svg>}
          <span title={file?.name}>{file ? file.name : '원본 그림 선택'}</span>
          <small>PNG · JPEG · 최대 {MAX_IMAGE_MB}MB</small>
          <input id={`${id}-file`} type="file" accept="image/png,image/jpeg" disabled={unavailable}
            onChange={event => { select(Array.from(event.target.files || [])); event.target.value = ''; }} />
        </label>
      </div>
      <div className="animal-create-fields">
        <label>이름<input value={pending ? pending.input.name : name} maxLength={80} disabled={unavailable} onChange={event => setName(event.target.value)} /></label>
        <label>종류<select value={pending ? pending.input.species : species} disabled={unavailable} onChange={event => setSpecies(event.target.value as Animal['species'])}>
          {Object.entries(speciesLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <div className="animal-create-actions">
          {pending
            ? <button disabled={busy} onClick={() => void submit()}>같은 요청 복구</button>
            : <button disabled={unavailable || !file || !name.trim()} onClick={() => void submit()}>{busy ? '추가 중' : '동물 추가'}</button>}
        </div>
      </div>
    </div>
    {(error || recovery.error) && <p role="alert">{error || recovery.error}</p>}
  </section>;
}

function Regenerate({ animal, onChange }: { animal: Animal; onChange(animal: Animal): void }) {
  const [redraw, setRedraw] = useState<AnimalView[]>([]), [note, setNote] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [, setSettled] = useState(0);
  const locked = useRef(false);
  // A saved request whose job the server already shows is settled; it must not hold the actions.
  useEffect(() => { if (studioApi.settleAnimalRecovery(animal)) setSettled(count => count + 1); }, [animal]);
  const recovery = studioApi.animalRecovery(animal.id), pending = recovery.pending;
  const job = animal.production;
  const active = !!job && ['accepted', 'running'].includes(job.status);
  const disabled = busy || active || !!pending || !!recovery.error;
  const has = (name: string) => animal.artifacts.some(item => item.name === name);
  const hasReference = has('reference.png'), hasModel = has('model.glb');
  const missing = viewChoices.map(([view]) => view).filter(view => !has(`${view}.png`));
  const credits = animal.stages.model?.credits;
  const meshy = typeof credits === 'number' && credits > 0 ? credits : MESHY_CREDITS;

  async function submit(input: AnimalRegenerateInput, key?: string) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { onChange(await studioApi.regenerateAnimal(animal.id, input, key)); setRedraw([]); setNote(''); }
    catch (cause) { setError((cause as Error).message); }
    finally { locked.current = false; setBusy(false); setSettled(count => count + 1); }
  }
  function resume() {
    if (!job) return;
    void submit({ views: job.views, note: job.note, model: job.steps.includes('model'), rig: job.steps.includes('rig') }, job.request_key);
  }

  return <section className="animal-regenerate" aria-label="다시 만들기">
    <h3>다시 만들기</h3>
    <div className="animal-regenerate-views" role="group" aria-label="다시 그릴 면">{viewChoices.map(([view, label]) =>
      <label key={view}><input type="checkbox" checked={redraw.includes(view)} disabled={disabled || !hasReference}
        onChange={event => setRedraw(current => event.target.checked ? [...current, view] : current.filter(item => item !== view))} />{label}</label>)}</div>
    <label>수정 요청<textarea value={note} maxLength={400} disabled={disabled || !hasReference} onChange={event => setNote(event.target.value)} /></label>
    <div className="animal-regenerate-actions">
      <button disabled={disabled || !hasReference} onClick={() => void submit({ views: viewChoices.map(([view]) => view), note: note.trim(), model: true, rig: true })}>
        처음부터 다시 만들기 · 유료 이미지 {viewChoices.length}장 + Meshy {meshy}크레딧</button>
      <button disabled={disabled || !hasReference || !redraw.length || missing.some(view => !redraw.includes(view))}
        onClick={() => void submit({ views: redraw, note: note.trim(), model: true, rig: true })}>
        선택한 면 다시 그리기 · 유료 이미지 {redraw.length}장 + Meshy {meshy}크레딧</button>
      <button disabled={disabled || missing.length > 0} onClick={() => void submit({ views: [], note: '', model: true, rig: true })}>3D 다시 만들기 · 유료 Meshy {meshy}크레딧</button>
      <button disabled={disabled || !hasModel} onClick={() => void submit({ views: [], note: '', model: false, rig: true })}>표준 골격 다시 씌우기</button>
      {pending && <button disabled={busy} onClick={() => void submit(pending.input, pending.key)}>같은 요청 복구</button>}
      {job?.status === 'paused' && !pending && <button disabled={busy} onClick={resume}>이어서 실행</button>}
    </div>
    {job && <p className="animal-production">{job.steps.map(step => stepLabels[step]).join(' → ')} · {statusLabels[job.status]}
      {job.step && active ? ` · ${stepLabels[job.step]} (${job.done.length + 1}/${job.steps.length})${progressLabel(job.progress)}` : ''}</p>}
    {(error || recovery.error || job?.error) && <p role="alert">{error || recovery.error || job?.error}</p>}
  </section>;
}

export default function Animals() {
  const listing = usePolling(studioApi.animals, 15000);
  const [opened, setOpened] = useState(''), [modelName, setModelName] = useState(''), [error, setError] = useState('');
  const [clips, setClips] = useState<{ index: number; name: string }[]>([]), [clip, setClip] = useState(0);
  const viewerMount = useRef<HTMLDivElement>(null), viewer = useRef<ModelViewer | null>(null);
  const items = listing.value?.items || [];
  const current = items.find(item => item.id === opened);
  const available = current ? models.filter(([name]) => artifact(current, name)) : [];
  const model = current && (artifact(current, modelName) || (available[0] && artifact(current, available[0][0])));

  useEffect(() => {
    if (!model || !viewerMount.current) return;
    let active = true;
    setError(''); setClips([]);
    const instance = new ModelViewer(viewerMount.current, 'studio');
    viewer.current = instance;
    void instance.load(model.url).then(loaded => {
      if (!active || !loaded.length) return;
      const first = Math.max(0, loaded.findIndex(item => item.name === 'walk'));
      instance.play(first); setClips(loaded); setClip(first);
    }).catch(cause => { if (active) setError((cause as Error).message); });
    return () => { active = false; instance.dispose(); if (viewer.current === instance) viewer.current = null; };
  }, [model?.url]);

  function replace(animal: Animal) {
    listing.setValue(previous => previous && { ...previous, items: previous.items.map(item => item.id === animal.id ? animal : item) });
  }

  function created(animal: Animal) {
    listing.setValue(previous => ({ ...previous, items: [...(previous?.items || []).filter(item => item.id !== animal.id), animal] }));
    setOpened(animal.id); setModelName('');
  }

  return <div className="workspace-content">
    <div className="workspace-heading"><h1>동물</h1></div>
    {listing.error && <p role="alert">{listing.error}</p>}
    <CreateAnimal onCreated={created} />
    <section className="asset-gallery" aria-labelledby="animal-gallery-title">
      <div className="asset-gallery-heading"><h2 id="animal-gallery-title">저장된 동물</h2></div>
      {items.length ? <div className="asset-gallery-grid animal-gallery-grid">{items.map(item => {
        const [name, label] = models.find(([file]) => artifact(item, file)) || [];
        const preview = name ? artifact(item, name) : undefined;
        return <article className="asset-gallery-card" key={item.id}>
          <AssetModelPreview model={preview && label ? { ...preview, label } : undefined} image={artifact(item, 'front.png') || artifact(item, 'reference.png')}
            name={item.name} emptyLabel="3D 생성 전" autoLoad animate clip="walk" />
          <div className="asset-gallery-info"><strong title={item.name}>{item.name}</strong><span>{speciesLabels[item.species] || item.species} · {summary(item)}</span></div>
          <div className="asset-gallery-actions"><button className="asset-open" onClick={() => { setOpened(item.id); setModelName(''); }}>크게 보기</button></div>
        </article>;
      })}</div> : !listing.loading && <p className="asset-gallery-empty">저장된 동물이 없습니다.</p>}
    </section>
    {current && <AssetDetailDialog title={current.name} onClose={() => setOpened('')}>
      {error && <p role="alert">{error}</p>}
      {available.length > 1 && <div className="animal-model-switch" role="group" aria-label="표시할 모델">{available.map(([name, label]) =>
        <button key={name} aria-pressed={model?.name === name} onClick={() => setModelName(name)}>{label}</button>)}</div>}
      {clips.length > 1 && <div className="animal-model-switch" role="group" aria-label="동작">{[...clips].sort((a, b) => (clipOrder.indexOf(a.name) + 1 || 99) - (clipOrder.indexOf(b.name) + 1 || 99)).map(item =>
        <button key={item.index} aria-pressed={clip === item.index} onClick={() => { viewer.current?.play(item.index); setClip(item.index); }}>{clipLabels[item.name] || item.name}</button>)}</div>}
      {model ? <div ref={viewerMount} className="generation-model" /> : <p className="asset-gallery-empty">3D 모델 없음</p>}
      <dl className="animal-stages">{stageRows(current).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <div className="animal-views">{views.map(([name, label]) => {
        const image = artifact(current, name);
        return image && <a key={name} href={image.url} target="_blank" rel="noreferrer"><img src={image.url} loading="lazy" decoding="async" alt={`${current.name} ${label}`} /><span>{label}</span></a>;
      })}</div>
      <Regenerate key={current.id} animal={current} onChange={replace} />
      <div className="artifact-grid">{current.artifacts.map(item => <a key={item.name} href={item.url} download>{item.name}</a>)}</div>
    </AssetDetailDialog>}
  </div>;
}
