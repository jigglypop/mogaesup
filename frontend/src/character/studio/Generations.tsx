import { useCallback, useEffect, useRef, useState } from 'react';
import { ModelViewer } from '../viewer';
import { usePolling } from '../use-polling';
import { studioHref } from '../../studio/screens';
import { generationsApi, type Generation, type GenerationSize } from './generations-api';
import './generations.css';

// The props screen: one image and one Meshy model per object.
const kind = 'prop';
const categoryOptions = [['furniture', '가구'], ['tree', '나무'], ['prop', '소품']] as const;
const statusLabels: Record<Generation['status'], string> = {
  accepted: '접수됨', running: '생성 중', paused: '일시 중지', blocked: '중단됨', complete: '완료',
};
const stageLabels: Record<Generation['stage'], string> = {
  image: '이미지', model: '3D 모델', material: '재질', complete: '완료',
};
const draftKey = `gaesup.studio.generation-draft.${kind}.v1`;
type Draft = { category: string; name: string; prompt: string; promptEdited: boolean; size: GenerationSize };

function readDraft(): Draft {
  try {
    const parsed = JSON.parse(localStorage.getItem(draftKey) || 'null') as Partial<Draft> | null;
    return {
      category: typeof parsed?.category === 'string' && categoryOptions.some(([value]) => value === parsed.category) ? parsed.category : categoryOptions[0][0],
      name: typeof parsed?.name === 'string' ? parsed.name : '',
      prompt: typeof parsed?.prompt === 'string' ? parsed.prompt : '',
      promptEdited: parsed?.promptEdited === true,
      size: parsed?.size === 256 || parsed?.size === 512 || parsed?.size === 1024 ? parsed.size : 512,
    };
  } catch { return { category: categoryOptions[0][0], name: '', prompt: '', promptEdited: false, size: 512 }; }
}

function previewImage(generation: Generation) {
  return generation.artifacts.find(artifact => /(?:preview|image|albedo|diffuse|front).*(?:png|jpe?g|webp)$/i.test(artifact.name))
    || generation.artifacts.find(artifact => /\.(?:png|jpe?g|webp)$/i.test(artifact.name));
}

function upsert(items: Generation[] | undefined, generation: Generation) {
  return [generation, ...(items || []).filter(item => item.id !== generation.id)];
}

export default function Generations() {
  const readList = useCallback((signal: AbortSignal) => generationsApi.list(kind, signal), []);
  const listing = usePolling(readList, 5000);
  const initialDraft = useRef(readDraft());
  const [category, setCategory] = useState<string>(initialDraft.current.category);
  const [name, setName] = useState(initialDraft.current.name);
  const [prompt, setPrompt] = useState(initialDraft.current.prompt);
  const [promptEdited, setPromptEdited] = useState(initialDraft.current.promptEdited);
  const [size, setSize] = useState<GenerationSize>(initialDraft.current.size);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), viewerMount = useRef<HTMLDivElement>(null);
  const recovery = generationsApi.recovery(kind), pending = recovery.pending;
  const current = listing.value?.items.find(item => item.id === selected)
    || listing.value?.items.find(item => item.kind === kind);
  const glb = current?.artifacts.find(artifact => artifact.name === 'model.glb')
    || current?.artifacts.find(artifact => artifact.name === 'source.glb')
    || current?.artifacts.find(artifact => /\.glb$/i.test(artifact.name));
  const currentDefault = listing.value?.defaults[category] || '';
  const capability = listing.value?.capabilities;
  const inputLocked = busy || !!pending || !!recovery.error;

  useEffect(() => {
    if (!promptEdited && currentDefault) setPrompt(currentDefault);
  }, [currentDefault, promptEdited]);
  useEffect(() => {
    try { localStorage.setItem(draftKey, JSON.stringify({ category, name, prompt, promptEdited, size } satisfies Draft)); }
    catch { /* Draft persistence must not block generation controls. */ }
  }, [category, name, prompt, promptEdited, size]);
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
  const canCreate = !!capability?.ready && !!name.trim() && !!prompt.trim() && !inputLocked;

  return <div className="workspace-content generations" aria-busy={busy}>
    <div className="workspace-heading"><h1>기물</h1></div>
    <section className="generation-compose">
      <div className="generation-fields">
        <label>분류<select value={pending?.input.category || category} disabled={inputLocked} onChange={event => selectCategory(event.target.value)}>{categoryOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>이름<input value={pending?.input.name ?? name} maxLength={80} disabled={inputLocked} onChange={event => setName(event.target.value)} /></label>
        <label>최대 텍스처 크기<select value={pending?.input.size || size} disabled={inputLocked} onChange={event => setSize(Number(event.target.value) as GenerationSize)}>{[256, 512, 1024].map(value => <option key={value} value={value}>{value} × {value}</option>)}</select></label>
        <label className="generation-prompt">프롬프트<textarea value={pending?.input.prompt ?? prompt} maxLength={8000} disabled={inputLocked} onChange={event => { setPrompt(event.target.value); setPromptEdited(true); }} /></label>
        <a className="prompt-management-link" href={studioHref({ tab: 'prompts', promptGroup: kind })} target="_blank" rel="noreferrer">프롬프트 관리 열기</a>
        <div className="generation-form-actions"><button type="button" disabled={inputLocked || !currentDefault} onClick={() => { setPrompt(currentDefault); setPromptEdited(false); }}>기본값 복원</button><button className="generation-submit is-primary" disabled={!canCreate && !pending} onClick={() => void perform(async () => {
          const input = pending?.input || { kind, category, name: name.trim(), prompt: prompt.trim(), size };
          const result = await generationsApi.create(input);
          setSelected(result.id);
          listing.setValue(previous => ({ ...(previous || { capabilities: capability || { ready: true }, defaults: listing.value?.defaults || {} }), items: upsert(previous?.items, result) }));
        })}>{busy ? '요청 확인 중' : pending ? '같은 요청 복구' : '유료 생성 · 이미지 1장 + Meshy 1회'}</button></div>
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
      {glb && <div ref={viewerMount} className="generation-model" />}
      <p className="generation-result-prompt">{current.prompt}</p>
      <div className="artifact-grid">{current.artifacts.map(artifact => <a key={`${artifact.name}:${artifact.sha256}`} href={artifact.url} download>{artifact.name}</a>)}</div>
    </section>}
  </div>;
}
