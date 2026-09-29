import { useCallback, useEffect, useRef, useState } from 'react';
import { isDefinitiveRejection } from '../api';
import { ModelViewer } from '../viewer';
import { factoryApi, type FactoryJob, type NativeOutfit, type NativePartsState } from './api';
import { usePolling } from '../use-polling';
import { MeshyMotion } from './MeshyMotion';
import { RigRecovery } from './RigRecovery';
import './meshy-motion.css';
import { Expressions } from '../studio/Expressions';
import { ImportedGlbPreview } from './ImportedGlbPreview';
import { NativePartRefit } from './NativePartRefit';
import { partLabels as labels } from './parts';

const views = [['front', '정면'], ['side', '왼쪽'], ['back', '후면'], ['opposite', '오른쪽']] as const;
const reviewGroups = [['', '전체'], ['body', '기본몸'], ['wardrobe', '의상'], ['head', '머리 착용 모습'], ['hair', '머리카락'], ['hairFront', '앞머리'], ['hairBack', '뒷머리'], ['hat', '머리 장식']] as const;
const equal = (a: string[], b: string[]) => a.length === b.length && a.every(slot => b.includes(slot));
type Pending = { key: string; revision: string; input: Pick<NativeOutfit, 'body_sha256' | 'slots' | 'hair_color'> };
function readPending(key: string): Pending | null {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; }
}

export function NativeAssembly({ jobId, simple = false, flow }: { jobId: string; simple?: boolean; flow?: FactoryJob['character_flow'] }) {
  const read = useCallback((signal: AbortSignal) => factoryApi.nativeParts(jobId, signal), [jobId]);
  const polling = usePolling(read, value => value && (['accepted', 'running'].includes(value.status) || value.expression_pending) ? 3000 : flow?.busy ? 5000 : 15000);
  const state = polling.value;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [rigControls, setRigControls] = useState(false);
  const submitting = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, [jobId]);
  async function assemble() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try { const value = await factoryApi.assemble(jobId); if (alive.current) polling.setValue(value); }
    catch (e) { if (alive.current) setError((e as Error).message); }
    finally { submitting.current = false; if (alive.current) setBusy(false); }
  }
  const currentAvailable = state?.status === 'review_required' && !!state.version;
  const preview = state?.preview?.status === 'review_required' && state.preview.version
    ? state.preview : undefined;
  const available = currentAvailable && !preview;
  const displayed = preview || (currentAvailable ? state : undefined);
  const imported = displayed?.origin === 'uploaded_glb';
  return <section className="native-assembly" data-assembly-job={jobId}>
    {(error || polling.error) && <p role="alert">{error || polling.error}</p>}
    {displayed && (imported ? <ImportedGlbPreview key={`${jobId}:${displayed.version}`} state={displayed} /> : <NativeCharacter key={`${jobId}:${preview ? 'preview:' : ''}${displayed.version}`} jobId={jobId} state={displayed} />)}
    {!available && <>
      <div className="meshy-motion">
      <h2>{simple ? flow?.busy ? '캐릭터 제작 중' : state?.status === 'qc_failed' ? '조립 재개' : state?.status === 'failed' ? '조립 중단' : '캐릭터' : '파츠 조립'}</h2>
      {!simple && <p>리깅·동작과 파츠 수신 대기</p>}
      {!simple && <button disabled={busy || !state || !!state.expression_pending || ['accepted', 'running'].includes(state.status)} onClick={() => void assemble()}>파츠 조립 · 로컬 처리</button>}
      {state && ['accepted', 'running'].includes(state.status) && <p role="status">파츠를 공통 골격에 연결하고 있습니다…</p>}
      {state?.expression_pending && <p role="status">새 조립에 저장된 표정을 적용하고 있습니다…</p>}
      {state?.error && <p role="alert">{state.error}</p>}
      {!simple && <RigRecovery jobId={jobId} onComplete={() => void polling.refresh()} />}
      </div>
    </>}
    <NativePartRefit key={jobId} jobId={jobId} state={state} disabled={busy || !!flow?.busy} onChange={polling.setValue} />
    {!simple && available && !imported && <button className="assembly-tools" aria-expanded={rigControls} onClick={() => setRigControls(value => !value)}>몸 리깅·추가 동작 설정</button>}
    {!simple && !imported && (!available || rigControls) && <MeshyMotion jobId={jobId} showRigRecovery={available} onRigRecovery={() => void polling.refresh()} />}
  </section>;
}

function NativeCharacter({ jobId, state }: { jobId: string; state: NativePartsState }) {
  const version = state.version!, storage = `gaesup.native-outfit:${jobId}:${version}`;
  const body = state.artifacts.find(a => a.name === 'body.glb');
  const parts = state.parts.filter(p => p.slot !== 'body' && p.available !== false
    && state.artifacts.some(asset => asset.name === `${p.slot}.glb`));
  const inputs = useRef(state); inputs.current = state;
  const mount = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null), viewer = useRef<ModelViewer | null>(null);
  const alive = useRef(true), saving = useRef(false), applied = useRef<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]), [saved, setSaved] = useState<string[]>([]);
  const [hairColor, setHairColor] = useState<string | null>(null), [savedHairColor, setSavedHairColor] = useState<string | null>(null);
  const [revision, setRevision] = useState('0'), [restored, setRestored] = useState(false);
  const [pending, setPending] = useState(!!readPending(storage)), [busy, setBusy] = useState(false);
  const [readyViewer, setReadyViewer] = useState<ModelViewer | null>(null);
  const ready = readyViewer !== null;
  const [wearing, setWearing] = useState(false), [attempt, setAttempt] = useState(0);
  const [clips, setClips] = useState<{ name: string; index: number }[]>([]), [motion, setMotion] = useState(-1);
  const [mode, setMode] = useState<'studio' | 'world'>('studio');
  const [reviewGroup, setReviewGroup] = useState('');
  const [modelError, setModelError] = useState(''), [wearError, setWearError] = useState(''), [saveError, setSaveError] = useState('');
  const selectedKey = JSON.stringify(selected);

  async function restore() {
    setBusy(true); setSaveError('');
    try {
      const outfit = await factoryApi.nativeOutfit(jobId, version);
      if (!alive.current) return;
      if (outfit.body_sha256 !== body?.sha256) throw new Error('저장된 조합의 몸 버전이 다릅니다.');
      const request = readPending(storage);
      const slots = request?.input.slots || outfit.slots;
      if (slots.some(slot => !parts.some(part => part.slot === slot))) throw new Error('저장된 파츠를 찾을 수 없습니다.');
      setRevision(outfit.revision); setSaved(outfit.slots); setSelected(slots); setPending(!!request); setRestored(true);
      setSavedHairColor(outfit.hair_color || null); setHairColor((request ? request.input.hair_color : outfit.hair_color) || null);
    } catch (e) { if (alive.current) setSaveError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void restore(); return () => { alive.current = false; }; }, [jobId, version]);

  useEffect(() => {
    setReadyViewer(null); setModelError(''); applied.current = [];
    if (!body) { setModelError('조립 몸의 파일이 없습니다.'); return; }
    let active = true;
    const instance = new ModelViewer(mount.current!, mode); viewer.current = instance;
    void instance.load(body.url, { sha256: body.sha256, wardrobe: true }).then(value => {
      if (!active) return;
      setClips(value);
      const start = -1;
      instance.play(start); setMotion(start); setReadyViewer(instance);
    }).catch(e => { if (active) setModelError(e.message); });
    const timer = setInterval(() => {
      const diagnostic = instance.wardrobeDiagnostics();
      if (!panel.current || !diagnostic) return;
      panel.current.dataset.sharedBones = String(diagnostic.shared);
      panel.current.dataset.boneCount = String(diagnostic.boneCount);
      panel.current.dataset.partIds = JSON.stringify(diagnostic.partIds);
      panel.current.dataset.partSamples = JSON.stringify(diagnostic.partSamples);
      panel.current.dataset.bodySample = JSON.stringify(diagnostic.bodySample);
    }, 300);
    return () => { active = false; clearInterval(timer); instance.dispose(); viewer.current = null; };
  }, [body?.url, body?.sha256, mode, attempt]);

  useEffect(() => {
    if (!ready || !restored || !viewer.current) return;
    let active = true; setWearing(true);
    const instance = viewer.current;
    void (async () => {
      const wearables = selected.map(slot => {
        const asset = inputs.current.artifacts.find(a => a.name === `${slot}.glb`);
        if (!asset) throw new Error(`${labels[slot] || slot} 파츠 파일이 없습니다.`);
        return { id: `${version}:${slot}`, slot, url: asset.url, sha256: asset.sha256 };
      });
      if (await instance.wear(wearables) && active) applied.current = [...selected];
    })().catch(e => {
      if (active) { setWearError(e.message); setSelected([...applied.current]); }
    }).finally(() => { if (active) setWearing(false); });
    return () => { active = false; };
  }, [selectedKey, ready, restored]);
  useEffect(() => { readyViewer?.setHairColor(hairColor); }, [readyViewer, hairColor]);

  async function save() {
    if (saving.current || !body) return;
    saving.current = true; setBusy(true); setSaveError('');
    const request = readPending(storage) || { key: crypto.randomUUID(), revision, input: { body_sha256: body.sha256, slots: [...applied.current], hair_color: hairColor } };
    try {
      sessionStorage.setItem(storage, JSON.stringify(request));
      await factoryApi.saveNativeOutfit(jobId, version, request.input, request.revision, request.key);
      // Replaying a receipt can return an older save after another tab has
      // written a new combination. Restore the current revision, not the receipt.
      const result = await factoryApi.nativeOutfit(jobId, version);
      sessionStorage.removeItem(storage);
      if (alive.current) { setRevision(result.revision); setSaved(result.slots); setSelected(result.slots); setHairColor(result.hair_color || null); setSavedHairColor(result.hair_color || null); }
    } catch (e) {
      if (isDefinitiveRejection(e)) sessionStorage.removeItem(storage);
      if (alive.current) setSaveError((e as Error).message);
    } finally {
      saving.current = false;
      if (alive.current) { setBusy(false); setPending(!!readPending(storage)); }
    }
  }
  const appliedSelection = ready && restored && !wearing && equal(selected, applied.current);
  return <section ref={panel} className="meshy-motion assembly-preview" data-assembly-ready={appliedSelection && !wearError ? version : ''}>
    <h2>캐릭터 미리보기</h2>
    {!!state.incomplete_parts?.length && <p role="status">미완성 파츠: {state.incomplete_parts.map(part => labels[part.slot] || part.slot).join(', ')}</p>}
    <div className="meshy-buttons"><button aria-pressed={mode === 'studio'} onClick={() => setMode('studio')}>동작</button><button aria-pressed={mode === 'world'} onClick={() => setMode('world')}>이동</button></div>
    <div className="meshy-scene" ref={mount} />
    <details className="assembly-originals"><summary>표정 적용 전 조립 이미지</summary>
    <div className="assembly-views" aria-label="저장된 모델 네 방향">
      {reviewGroups.filter(([group]) => state.artifacts.some(a => a.name === `${group ? `${group}-` : ''}front.png`)).map(([group, title]) =>
        <button key={group} aria-pressed={reviewGroup === group} onClick={() => setReviewGroup(group)}>{title}</button>)}
    </div>
    <div className="assembly-renders">{views.map(([view, title]) => {
      const artifact = state.artifacts.find(a => a.name === `${reviewGroup ? `${reviewGroup}-` : ''}${view}.png`);
      return artifact && <a key={view} href={artifact.url} target="_blank" rel="noreferrer"><img src={artifact.url} alt={`${reviewGroups.find(([group]) => group === reviewGroup)?.[1]} ${title}`} loading="lazy" />{title}</a>;
    })}</div>
    </details>
    {mode === 'world' && <p>W·A·S·D 이동 · Shift 달리기</p>}
    {mode === 'studio' && <div className="meshy-clips"><button disabled={!ready} aria-pressed={motion === -1} onClick={() => { viewer.current?.play(-1); setMotion(-1); }}>기본 자세</button>{clips.map(c => <button disabled={!ready} key={c.index} aria-pressed={motion === c.index} onClick={() => { viewer.current?.play(c.index); setMotion(c.index); }}>{c.name}</button>)}</div>}
    {body && <Expressions key={`${jobId}:${version}:${mode}`} job={jobId} version={version} bodySha={body.sha256} viewer={readyViewer} />}
    <fieldset className="assembly-parts" disabled={!ready || !restored || busy || pending}><legend>착용 파츠</legend>
      <span>기본 몸 · 항상 포함</span>
      {parts.map(part => <label key={part.slot}><input type="checkbox" checked={selected.includes(part.slot)} onChange={e => { const checked = e.target.checked; setWearError(''); setSelected(current => checked ? [...current, part.slot] : current.filter(slot => slot !== part.slot)); }} />{labels[part.slot] || part.slot}</label>)}
      <button onClick={() => { setWearError(''); setSelected(parts.map(part => part.slot)); }}>모두 착용</button>
    </fieldset>
    {parts.some(part => ['hair','hairFront','hairBack'].includes(part.slot)) && <fieldset className="assembly-parts" disabled={!ready || !restored || busy || pending}><legend>헤어 색상</legend>
      <label>색상<input type="color" aria-label="헤어 색상" value={hairColor || '#8a7998'} onChange={event => setHairColor(event.target.value)} /></label><span>{hairColor || '원본 색상'}</span><button onClick={() => setHairColor(null)}>원본 색상</button>
    </fieldset>}
    {(!ready || wearing) && !modelError && <p role="status">캐릭터와 착용 파츠를 불러오는 중…</p>}
    {modelError && <p role="alert">{modelError} <button onClick={() => setAttempt(value => value + 1)}>캐릭터 다시 불러오기</button></p>}
    {wearError && <p role="alert">{wearError} 이전에 적용된 조합을 유지했습니다.</p>}
    {saveError && <p role="alert">{saveError}</p>}
    {pending && <p role="status">저장 응답이 확인되지 않았습니다. 같은 요청으로 결과를 복구할 수 있습니다.</p>}
    <div className="meshy-buttons"><button disabled={busy || !appliedSelection || !!wearError || (!pending && equal(selected, saved) && hairColor === savedHairColor && revision !== '0')} onClick={() => void save()}>{pending ? '조합 저장 결과 복구' : '현재 조합 저장'}</button><button disabled={busy || pending} onClick={() => void restore()}>저장한 조합 다시 불러오기</button></div>
    {restored && !pending && revision !== '0' && equal(selected, saved) && hairColor === savedHairColor && <p role="status">저장된 조합입니다.</p>}
    <div className="meshy-buttons">{state.artifacts.filter(a => ['model.glb', 'master.blend'].includes(a.name)).map(a => <a className="meshy-download" key={a.name} href={a.url} download>{a.name === 'model.glb' ? '전체 파츠 조립 GLB' : '조립 Blender 원본'}</a>)}</div>
  </section>;
}
