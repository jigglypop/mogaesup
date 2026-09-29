import { useCallback, useEffect, useRef, useState } from 'react';
import { usePolling } from '../use-polling';
import { generationsApi, type Generation, type VectorColors } from './generations-api';
import { EmoticonRig } from './EmoticonRig';
import './generations.css';
import './emoticons.css';

const storage = 'gaesup.studio.illustration-draft.v1';
const labels = { accepted: '접수됨', running: '생성 중', paused: '일시 중단', blocked: '중단됨', complete: '완료' };
const colorChoices: VectorColors[] = [12, 16, 24, 32];
const artwork = (item?: Generation) => item?.artifacts.find(artifact => artifact.name === 'image.png');
const vectorArt = (item?: Generation) => item?.artifacts.find(artifact => artifact.name === 'image.svg');
// A new trace keeps the file name; the hash makes the preview reload.
const versioned = (artifact: { url: string; sha256: string }) => `${artifact.url}?v=${artifact.sha256.slice(0, 12)}`;
function readDraft() {
  try {
    const value = JSON.parse(localStorage.getItem(storage) || 'null');
    return { name: typeof value?.name === 'string' ? value.name : '', prompt: typeof value?.prompt === 'string' ? value.prompt : '',
      edited: value?.edited === true, useReference: value?.useReference !== false };
  } catch { return { name: '', prompt: '', edited: false, useReference: true }; }
}

export default function Emoticons() {
  const read = useCallback((signal: AbortSignal) => generationsApi.list('illustration', signal), []);
  const listing = usePolling(read, 5000);
  const selection = usePolling(generationsApi.illustrationSelection, 10000);
  const [draft, setDraft] = useState(readDraft);
  const [currentId, setCurrentId] = useState('');
  const [limit, setLimit] = useState(24);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), alive = useRef(true);
  const recovery = generationsApi.recovery('illustration'), pending = recovery.pending;
  const items = listing.value?.items || [];
  const current = items.find(item => item.id === currentId) || items[0];
  const base = items.find(item => item.id === selection.value?.selected);
  const currentImage = artwork(current), baseImage = artwork(base), currentVector = vectorArt(current);
  const [colors, setColors] = useState<VectorColors>(16), [tracing, setTracing] = useState(false);
  const inputLocked = busy || !!pending || !!recovery.error;
  const defaultPrompt = listing.value?.defaults.character || '';
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setColors(current?.vector?.colors || 16); }, [current?.id, current?.vector?.colors]);
  useEffect(() => {
    if (defaultPrompt) setDraft(value => value.edited ? value : { ...value, prompt: defaultPrompt });
  }, [defaultPrompt]);
  useEffect(() => {
    try { localStorage.setItem(storage, JSON.stringify(draft)); } catch { /* The paid intent must still persist before submission. */ }
  }, [draft]);
  useEffect(() => {
    if (pending) setDraft({ name: pending.input.name, prompt: pending.input.prompt, edited: true, useReference: !!pending.input.reference_id });
  }, [pending?.key]);
  useEffect(() => {
    const sync = () => setDraft(readDraft());
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  async function perform(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (cause) { if (alive.current) setError((cause as Error).message); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  function remember(item: Generation) {
    if (!alive.current) return;
    setCurrentId(item.id);
    listing.setValue(previous => previous && ({ ...previous, items: [item, ...previous.items.filter(value => value.id !== item.id)] }));
  }
  async function selectBase() {
    if (!current || !selection.value) return;
    try {
      const result = await generationsApi.selectIllustration(current.id, selection.value.revision);
      if (alive.current) { selection.setValue(result); setDraft(value => ({ ...value, useReference: true })); }
    } catch (cause) { await selection.refresh(); throw cause; }
  }
  return <div className="workspace-content generations emoticons">
    <section className="generation-compose">
      <h1>2D 이모티콘</h1>
      <form onSubmit={event => { event.preventDefault(); void perform(async () => {
        const input = pending?.input || { kind: 'illustration' as const, category: 'character', size: 1024 as const,
          name: draft.name.trim(), prompt: draft.prompt.trim(), ...(draft.useReference && base ? { reference_id: base.id } : {}) };
        remember(await generationsApi.create(input));
        await listing.refresh();
      }); }}>
        <label>원화 이름<input required maxLength={80} value={pending?.input.name ?? draft.name} disabled={inputLocked}
          onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} /></label>
        <label>기준 원화<select disabled={inputLocked || !selection.value} value={draft.useReference && base ? 'selected' : 'new'}
          onChange={event => setDraft(value => ({ ...value, useReference: event.target.value === 'selected' }))}>
          <option value="new">새 원화</option>{base && <option value="selected">{base.name}</option>}
        </select></label>
        <a className="prompt-management-link" href="/?tab=prompts&promptGroup=illustration" target="_blank" rel="noreferrer">프롬프트 관리 열기</a>
        <label className="generation-prompt">프롬프트<textarea required maxLength={8000} value={pending?.input.prompt ?? draft.prompt} disabled={inputLocked}
          onChange={event => setDraft(value => ({ ...value, prompt: event.target.value, edited: true }))} /></label>
        <div className="generation-form-actions">
          <button type="button" disabled={inputLocked || !defaultPrompt} onClick={() => setDraft(value => ({ ...value, prompt: defaultPrompt, edited: false }))}>기본 표정 프롬프트</button>
          <button className="generation-submit" disabled={busy || !!recovery.error || (!pending && (!listing.value?.capabilities.ready || !selection.value || !draft.name.trim() || !draft.prompt.trim()))}>
            {busy ? '요청 확인 중' : pending ? '같은 요청 복구' : '원화 생성 · 이미지 1회'}
          </button>
        </div>
        {listing.value && !listing.value.capabilities.ready && <p>{listing.value.capabilities.reason}</p>}
        {pending && <p className="generation-recovery">접수한 이름·프롬프트·기준 원화로 요청을 복구합니다.</p>}
      </form>
    </section>
    {(error || listing.error || selection.error || recovery.error) && <p className="workspace-error" role="alert">{error || recovery.error || listing.error || selection.error}
      <button onClick={() => { void listing.refresh(); void selection.refresh(); }}>다시 불러오기</button></p>}
    {(baseImage || current) && <section className="generation-result">
      <div className="illustration-comparison">
        {baseImage && <figure><figcaption>기준 원화 · {base!.name}</figcaption><img src={baseImage.url} alt={`기준 원화 ${base!.name}`} /></figure>}
        {current && <figure><figcaption>{current.name} · {labels[current.status]}</figcaption>
          {currentImage ? <img src={currentImage.url} alt={current.name} /> : <div className="generation-no-preview">{labels[current.status]}</div>}
        </figure>}
        {current?.vector && currentVector && <figure><figcaption>SVG · 색 {current.vector.palette.length} · 경로 {current.vector.paths.toLocaleString()} · {Math.round(current.vector.bytes / 1024).toLocaleString()}KB</figcaption>
          <img src={versioned(currentVector)} alt={`${current.name} SVG`} />
        </figure>}
      </div>
      {current && <>
        <pre className="generation-result-prompt">{current.prompt}</pre>
        {current.reference_id && <p>참고 원화: {items.find(item => item.id === current.reference_id)?.name || current.reference_id}</p>}
        {current.error && <p role="alert">{current.error}</p>}
        {current.status === 'complete' && currentImage && <div className="vector-tools">
          <label>SVG 색 수<select value={colors} disabled={busy} onChange={event => setColors(Number(event.target.value) as VectorColors)}>
            {colorChoices.map(value => <option key={value} value={value}>{value}색</option>)}</select></label>
          <button disabled={busy || (current.vector?.colors === colors && !!currentVector)} onClick={() => void perform(async () => {
            setTracing(true);
            try { remember(await generationsApi.vectorize(current.id, colors)); } finally { if (alive.current) setTracing(false); }
          })}>{tracing ? 'SVG 만드는 중' : currentVector ? `${colors}색으로 다시 만들기` : 'SVG 만들기'}</button>
          {current.vector && currentVector && <ul className="vector-palette" aria-label="SVG 색상">{current.vector.palette.map(color =>
            <li key={color} style={{ background: color }} title={color} />)}</ul>}
        </div>}
        <div className="generation-form-actions">
          <button disabled={inputLocked} onClick={() => setDraft(value => ({ ...value, name: current.name, prompt: current.prompt, edited: true }))}>프롬프트 가져오기</button>
          <button disabled={busy || !selection.value || current.status !== 'complete' || !currentImage || base?.id === current.id} onClick={() => void perform(selectBase)}>기준 원화로 선택</button>
          {current.can_resume && <button disabled={busy} onClick={() => void perform(async () => remember(await generationsApi.resume(current.id)))}>계속 진행</button>}
          {currentImage && <a href={`${currentImage.url}?download=1`}>PNG 다운로드</a>}
          {currentVector && <a href={`${versioned(currentVector)}&download=1`}>SVG 다운로드</a>}
        </div>
      </>}
    </section>}
    {current?.status === 'complete' && currentImage && <EmoticonRig key={current.id} generation={current} busy={busy} perform={perform} onChange={remember} />}
    <section className="generation-library"><h2>원화 갤러리 · {items.length}</h2>
      <div className="generation-list">{items.slice(0, limit).map(item => <button className={`generation-card${current?.id === item.id ? ' selected' : ''}`} key={item.id} onClick={() => setCurrentId(item.id)}>
        {artwork(item) ? <img src={artwork(item)!.url} alt={item.name} loading="lazy" decoding="async" /> : <div className="generation-no-preview">{labels[item.status]}</div>}
        <span className="generation-card-copy"><strong>{item.name}{base?.id === item.id ? ' · 기준 원화' : ''}</strong><small>{labels[item.status]} · {new Date(item.created_at).toLocaleString()}</small></span>
      </button>)}</div>
      {items.length > limit && <button onClick={() => setLimit(value => value + 24)}>더 보기</button>}
      {!items.length && <p className="generation-empty">{listing.loading ? '불러오는 중' : '저장된 원화 없음'}</p>}
    </section>
  </div>;
}
