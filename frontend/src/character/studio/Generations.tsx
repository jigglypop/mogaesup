import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ModelViewer } from '../viewer';
import { usePolling } from '../use-polling';
import type { Tile } from './api';
import { generationsApi, type Generation, type GenerationSize } from './generations-api';
import type { TileShape } from './TilePreview';
import './generations.css';
import './textures.css';

const TilePreview = lazy(() => import('./TilePreview'));
type GenerationKind = 'prop' | 'texture';

const categoryOptions = {
  prop: [['furniture', '가구'], ['tree', '나무'], ['prop', '소품']],
  texture: [['wood', '목재'], ['bark', '나무껍질'], ['stone', '석재'], ['snow', '눈'], ['sand', '모래'], ['grass', '잔디'], ['soil', '흙'], ['brick', '벽돌'], ['custom', '직접 입력']],
} as const;
const statusLabels: Record<Generation['status'], string> = {
  accepted: '접수됨', running: '생성 중', paused: '일시 중지', blocked: '중단됨', complete: '완료',
};
const stageLabels: Record<Generation['stage'], string> = {
  image: '이미지', model: '3D 모델', material: '재질', complete: '완료',
};
const draftKey = (kind: GenerationKind) => `gaesup.studio.generation-draft.${kind}.v1`;
type Draft = { category: string; name: string; prompt: string; promptEdited: boolean; size: GenerationSize };

function readDraft(kind: GenerationKind): Draft {
  try {
    const parsed = JSON.parse(localStorage.getItem(draftKey(kind)) || 'null') as Partial<Draft> | null;
    return {
      category: typeof parsed?.category === 'string' && categoryOptions[kind].some(([value]) => value === parsed.category) ? parsed.category : categoryOptions[kind][0][0],
      name: typeof parsed?.name === 'string' ? parsed.name : '',
      prompt: typeof parsed?.prompt === 'string' ? parsed.prompt : '',
      promptEdited: parsed?.promptEdited === true,
      size: parsed?.size === 256 || parsed?.size === 512 || parsed?.size === 1024 ? parsed.size : 512,
    };
  } catch { return { category: categoryOptions[kind][0][0], name: '', prompt: '', promptEdited: false, size: 512 }; }
}

function previewImage(generation: Generation) {
  return generation.artifacts.find(artifact => /(?:preview|image|albedo|diffuse|front).*(?:png|jpe?g|webp)$/i.test(artifact.name))
    || generation.artifacts.find(artifact => /\.(?:png|jpe?g|webp)$/i.test(artifact.name));
}

function generationTile(generation: Generation): Tile {
  return {
    id: generation.id,
    surface: generation.category,
    size: generation.size,
    seed: 0,
    gpu: generation.gpu || { estimated_bytes_with_mips: 0 },
    artifacts: generation.artifacts,
  };
}

function upsert(items: Generation[] | undefined, generation: Generation) {
  return [generation, ...(items || []).filter(item => item.id !== generation.id)];
}

export default function Generations({ kind }: { kind: GenerationKind }) {
  const readList = useCallback((signal: AbortSignal) => generationsApi.list(kind, signal), [kind]);
  const listing = usePolling(readList, 5000);
  const initialDraft = useRef(readDraft(kind));
  const [category, setCategory] = useState<string>(initialDraft.current.category);
  const [name, setName] = useState(initialDraft.current.name);
  const [prompt, setPrompt] = useState(initialDraft.current.prompt);
  const [promptEdited, setPromptEdited] = useState(initialDraft.current.promptEdited);
  const [size, setSize] = useState<GenerationSize>(initialDraft.current.size);
  const [tileShape, setTileShape] = useState<TileShape>('plane');
  const [tileRepeat, setTileRepeat] = useState(3);
  const [tileOrbit, setTileOrbit] = useState(false);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), viewerMount = useRef<HTMLDivElement>(null);
  const recovery = generationsApi.recovery(kind), pending = recovery.pending;
  const current = listing.value?.items.find(item => item.id === selected)
    || listing.value?.items.find(item => item.kind === kind);
  const glb = kind === 'prop' ? current?.artifacts.find(artifact => artifact.name === 'model.glb')
    || current?.artifacts.find(artifact => artifact.name === 'source.glb')
    || current?.artifacts.find(artifact => /\.glb$/i.test(artifact.name)) : undefined;
  const hasTextureMaps = kind === 'texture' && ['albedo.webp', 'normal.webp', 'orm.webp']
    .every(name => current?.artifacts.some(artifact => artifact.name === name));
  const currentDefault = listing.value?.defaults[category] || '';
  const capability = listing.value?.capabilities;
  const inputLocked = busy || !!pending || !!recovery.error;

  useEffect(() => {
    const draft = readDraft(kind);
    initialDraft.current = draft;
    setCategory(draft.category); setName(draft.name); setPrompt(draft.prompt);
    setPromptEdited(draft.promptEdited); setSize(draft.size); setSelected(''); setError('');
  }, [kind]);
  useEffect(() => {
    if (!promptEdited && currentDefault) setPrompt(currentDefault);
  }, [currentDefault, promptEdited]);
  useEffect(() => {
    try { localStorage.setItem(draftKey(kind), JSON.stringify({ category, name, prompt, promptEdited, size } satisfies Draft)); }
    catch { /* Draft persistence must not block generation controls. */ }
  }, [kind, category, name, prompt, promptEdited, size]);
  useEffect(() => {
    if (!pending) return;
    setCategory(pending.input.category); setName(pending.input.name); setPrompt(pending.input.prompt);
    setPromptEdited(true); setSize(pending.input.size);
  }, [pending?.key]);
  useEffect(() => {
    if (!glb || !viewerMount.current) return;
    let active = true;
    const viewer = new ModelViewer(viewerMount.current, 'studio');
    void viewer.load(glb.url).catch(cause => { if (active) setError((cause as Error).message); });
    return () => { active = false; viewer.dispose(); };
  }, [glb?.url]);

  async function perform(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await action(); } catch (cause) { setError((cause as Error).message); }
    finally { locked.current = false; setBusy(false); }
  }
  function selectCategory(next: string) {
    setCategory(next);
    if (!promptEdited) setPrompt(listing.value?.defaults[next] || '');
  }
  const createLabel = kind === 'prop' ? '유료 생성 · 이미지 1장 + Meshy 1회' : '유료 생성 · 이미지 1장';
  const canCreate = !!capability?.ready && !!name.trim() && !!prompt.trim() && !inputLocked;

  return <div className="workspace-content generations" aria-busy={busy}>
    <div className="workspace-heading"><h1>{kind === 'prop' ? '오브젝트 생성' : '텍스처 생성'}</h1></div>
    <section className="generation-compose">
      <div className="generation-fields">
        <label>분류<select value={pending?.input.category || category} disabled={inputLocked} onChange={event => selectCategory(event.target.value)}>{categoryOptions[kind].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>이름<input value={pending?.input.name ?? name} maxLength={80} disabled={inputLocked} onChange={event => setName(event.target.value)} /></label>
        <label>{kind === 'prop' ? '최대 텍스처 크기' : '타일 해상도'}<select value={pending?.input.size || size} disabled={inputLocked} onChange={event => setSize(Number(event.target.value) as GenerationSize)}>{[256, 512, 1024].map(value => <option key={value} value={value}>{value} × {value}</option>)}</select></label>
        <label className="generation-prompt">프롬프트<textarea value={pending?.input.prompt ?? prompt} maxLength={8000} disabled={inputLocked} onChange={event => { setPrompt(event.target.value); setPromptEdited(true); }} /></label>
        <a className="prompt-management-link" href={`/?tab=prompts&promptGroup=${kind}`} target="_blank" rel="noreferrer">프롬프트 관리 열기</a>
        <div className="generation-form-actions"><button type="button" disabled={inputLocked || !currentDefault} onClick={() => { setPrompt(currentDefault); setPromptEdited(false); }}>기본값 복원</button><button className="generation-submit" disabled={!canCreate && !pending} onClick={() => void perform(async () => {
          const input = pending?.input || { kind, category, name: name.trim(), prompt: prompt.trim(), size };
          const result = await generationsApi.create(input);
          setSelected(result.id);
          listing.setValue(previous => ({ ...(previous || { capabilities: capability || { ready: true }, defaults: listing.value?.defaults || {} }), items: upsert(previous?.items, result) }));
        })}>{busy ? '요청 확인 중' : pending ? '같은 요청 복구' : createLabel}</button></div>
        {capability && !capability.ready && <small className="generation-capability">{capability.reason || '현재 생성 기능을 사용할 수 없습니다.'}</small>}
        {pending && <small className="generation-recovery">응답이 확인되지 않은 요청입니다. 같은 요청 키로 결과를 복구합니다.</small>}
      </div>
    </section>
    {(error || recovery.error || listing.error) && <p role="alert">{error || recovery.error || listing.error}</p>}
    <section className="generation-library" aria-labelledby={`${kind}-generation-library`}>
      <h2 id={`${kind}-generation-library`}>저장된 생성 결과</h2>
      {listing.value?.items.length ? <div className="generation-list">{listing.value.items.map(item => {
        const image = previewImage(item);
        return <button key={item.id} className={`generation-card ${current?.id === item.id ? 'selected' : ''}`} onClick={() => setSelected(item.id)}>
          {image ? <img src={image.url} loading="lazy" decoding="async" alt={`${item.name} 생성 이미지`} /> : <span className="generation-no-preview">미리보기 없음</span>}
          <span className="generation-card-copy"><strong>{item.name}</strong><small>{statusLabels[item.status]} · {stageLabels[item.stage]}{item.progress != null ? ` · ${Math.round(item.progress)}%` : ''}</small>{item.error && <small className="generation-item-error">{item.error}</small>}</span>
        </button>;
      })}</div> : !listing.loading && <p className="generation-empty">저장된 결과가 없습니다.</p>}
    </section>
    {current && <section className="generation-result">
      <div className="generation-result-heading"><div><h2>{current.name}</h2><small>{statusLabels[current.status]} · {stageLabels[current.stage]} · {new Date(current.created_at).toLocaleString()}</small></div>{current.can_resume && <button disabled={busy} onClick={() => void perform(async () => {
        const result = await generationsApi.resume(current.id); setSelected(result.id);
        listing.setValue(previous => previous && ({ ...previous, items: upsert(previous.items, result) }));
      })}>계속 진행</button>}</div>
      {kind === 'prop' && glb && <div ref={viewerMount} className="generation-model" />}
      {hasTextureMaps && <><div className="generation-tile-controls"><label>형태<select value={tileShape} onChange={event => setTileShape(event.target.value as TileShape)}><option value="plane">평면</option><option value="cube">큐브</option><option value="sphere">구</option></select></label><label>반복<input type="number" min={1} max={12} value={tileRepeat} onChange={event => setTileRepeat(Math.max(1, Math.min(12, Number(event.target.value) || 1)))} /></label><label className="generation-tile-check"><input type="checkbox" checked={tileOrbit} onChange={event => setTileOrbit(event.target.checked)} /> 자동 회전</label></div><Suspense fallback={<div className="generation-tile-loading">미리보기 불러오는 중</div>}><TilePreview tile={generationTile(current)} shape={tileShape} repeat={tileRepeat} autoOrbit={tileOrbit} /></Suspense></>}
      <p className="generation-result-prompt">{current.prompt}</p>
      <div className="artifact-grid">{current.artifacts.map(artifact => <a key={`${artifact.name}:${artifact.sha256}`} href={artifact.url} download>{artifact.name}</a>)}</div>
    </section>}
  </div>;
}
