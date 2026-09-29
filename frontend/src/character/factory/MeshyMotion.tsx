import { useCallback, useEffect, useRef, useState } from 'react';
import { ModelViewer } from '../viewer';
import { factoryApi, type MeshyAction, type MeshyState } from './api';
import './meshy-motion.css';
import { usePolling } from '../use-polling';
import { RigRecovery } from './RigRecovery';

const motionLabels: Record<string, string> = { idle: '대기', walk: '걷기', run: '달리기', jump: '점프', fall: '낙하', sit: '앉기', armsUp: '팔 들기', crouch: '웅크리기' };
const allSlots = Object.keys(motionLabels);

export function MeshyMotion({ jobId, visibleSlots = allSlots, showRigRecovery = true, onRigRecovery }: { jobId: string; visibleSlots?: string[]; showRigRecovery?: boolean; onRigRecovery?: () => void }) {
  const read = useCallback((signal:AbortSignal) => factoryApi.meshy(jobId,signal),[jobId]);
  const polling = usePolling<MeshyState>(read, value => value?.busy ? 2500 : 15000), state = polling.value, setState = polling.setValue;
  const [library, setLibrary] = useState<MeshyAction[]>([]);
  const [defaults, setDefaults] = useState<Record<string, number>>({}), [slot, setSlot] = useState(visibleSlots[0] || 'walk');
  const [actionId, setActionId] = useState<number>(), [search, setSearch] = useState(''), [category, setCategory] = useState('');
  const error = polling.error;
  const [catalogError, setCatalogError] = useState(''), [defaultsError, setDefaultsError] = useState(''), [notice, setNotice] = useState('');
  const [defaultsLoading, setDefaultsLoading] = useState(true);
  const [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [clips, setClips] = useState<{name: string; index: number}[]>([]), [motion, setMotion] = useState(-1);
  const [ready, setReady] = useState(false), [previewError, setPreviewError] = useState('');
  const [recoveryId, setRecoveryId] = useState('');
  const mount = useRef<HTMLDivElement>(null), viewer = useRef<ModelViewer | null>(null);
  const catalogRequest = useRef<AbortController | null>(null), defaultsRequest = useRef<AbortController | null>(null);
  const jobIdRef = useRef(jobId), slotRef = useRef(slot), operationToken = useRef(0);
  jobIdRef.current = jobId; slotRef.current = slot;
  const chosen = library.find(a => a.action_id === actionId);
  const url = state?.artifacts.find(a => a.name === 'model.glb')?.url;
  const filtered = library.filter(a => (!category || a.category === category) && (!search || `${a.name} ${a.key} ${a.action_id}`.toLowerCase().includes(search.toLowerCase())));

  function loadLibrary() {
    catalogRequest.current?.abort();
    const controller = new AbortController(); catalogRequest.current = controller;
    void factoryApi.motionLibrary(controller.signal).then(catalog => {
      if (controller.signal.aborted || catalogRequest.current !== controller) return;
      setLibrary(catalog.items); setCatalogError('');
    }).catch(e => {
      if (!controller.signal.aborted && catalogRequest.current === controller) setCatalogError((e as Error).message);
    });
  }
  function loadDefaults() {
    defaultsRequest.current?.abort();
    const controller = new AbortController(), requestedJobId = jobId; defaultsRequest.current = controller;
    setDefaultsError(''); setDefaultsLoading(true);
    void factoryApi.motionDefaults(requestedJobId, controller.signal).then(saved => {
      if (controller.signal.aborted || defaultsRequest.current !== controller || jobIdRef.current !== requestedJobId) return;
      setDefaults(saved.selections); setActionId(saved.selections[slotRef.current]); setDefaultsLoading(false);
    }).catch(e => {
      if (!controller.signal.aborted && defaultsRequest.current === controller && jobIdRef.current === requestedJobId) { setDefaultsError((e as Error).message); setDefaultsLoading(false); }
    });
  }
  useEffect(() => { loadLibrary(); return () => { catalogRequest.current?.abort(); }; }, []);
  useEffect(() => {
    operationToken.current += 1; busyRef.current = false; setBusy(false); setNotice('');
    loadDefaults();
    return () => { operationToken.current += 1; defaultsRequest.current?.abort(); };
  }, [jobId]);
  useEffect(() => {
    if (visibleSlots.includes(slot)) return;
    const nextSlot = visibleSlots[0] || 'walk'; setSlot(nextSlot); setActionId(defaults[nextSlot]);
  }, [defaults, slot, visibleSlots]);
  useEffect(() => {
    setReady(false); setClips([]); setMotion(-1); setPreviewError('');
    if (!url) return;
    let alive = true;
    const instance = new ModelViewer(mount.current!, 'studio'); viewer.current = instance;
    void instance.load(url).then(value => { if (alive) { setClips(value); setReady(true); } }).catch(e => { if (alive) setPreviewError(e.message); });
    return () => { alive = false; instance.dispose(); viewer.current = null; };
  }, [url]);

  async function perform(operation: () => Promise<unknown>, message: string, refreshRig = true) {
    if (busyRef.current) return;
    const token = operationToken.current, requestedJobId = jobId;
    busyRef.current = true; setBusy(true); setNotice('');
    try {
      await operation();
      if (token !== operationToken.current || jobIdRef.current !== requestedJobId) return;
      if (refreshRig) {
        const refreshed = await factoryApi.meshy(requestedJobId);
        if (token !== operationToken.current || jobIdRef.current !== requestedJobId) return;
        setState(refreshed);
      }
      setNotice(message);
    }
    catch (e) { if (token === operationToken.current && jobIdRef.current === requestedJobId) setNotice((e as Error).message); }
    finally { if (token === operationToken.current && jobIdRef.current === requestedJobId) { busyRef.current = false; setBusy(false); } }
  }
  async function saveDefault() {
    if (!chosen) return;
    const requestedJobId = jobId, token = operationToken.current;
    defaultsRequest.current?.abort();
    await perform(async () => {
      const saved = await factoryApi.saveMotionDefaults({[slot]: chosen.action_id}, requestedJobId);
      if (token === operationToken.current && jobIdRef.current === requestedJobId) {
        setDefaults(saved.selections); setDefaultsError('');
      }
    }, `${motionLabels[slot]} 공통 기본 동작을 저장했습니다.`, false);
  }
  const running = busy || state?.busy;
  const pending = state?.actions.find(a => a.action_id === actionId);
  return <section className="meshy-motion" data-meshy-job={jobId} data-meshy-ready={ready ? state?.version : ''}>
    <header><h2>Meshy 리깅 · 실제 동작</h2><p>{state?.origin === 'transferred_meshy_rig' ? '기존 Meshy 골격과 저장된 동작을 새 몸에 이전했습니다.' : state?.rig_task_id ? `Meshy 작업 ${state.rig_task_id}` : '생성된 전신 모델에 Meshy 리깅을 연결합니다.'}</p>
      <p>{state?.bone_count ? state.origin === 'transferred_meshy_rig' ? `저장된 Meshy 골격 ${state.bone_count}개 본 · 새 몸 외형 유지` : `Meshy 원본 골격 ${state.bone_count}개 본 · 원본 가중치 유지` : state?.busy ? `Meshy 처리 중 · ${state.progress}%` : 'Meshy 리깅 결과 대기'}</p>
      {!url && (state?.can_resume || state?.status === 'not_started') && <button disabled={running} onClick={() => void perform(() => factoryApi.meshyRig(jobId), 'Meshy 작업을 접수했습니다.')}>{state?.status === 'not_started' ? 'Meshy 리깅 가져오기 · 유료 최대 1회' : '기존 Meshy 작업 조회·이어가기'}</button>}
      {url && state?.error && state.can_resume && <button disabled={running} onClick={() => void perform(() => factoryApi.meshyRig(jobId), '기존 작업을 조회합니다.')}>기존 작업 이어가기</button>}
      {(error || state?.error) && <p role="alert">{error || state?.error}</p>}
    </header>
    {showRigRecovery && <RigRecovery jobId={jobId} onComplete={onRigRecovery} />}
    <div className="meshy-scene" ref={mount} />
    {previewError && <p role="alert">{previewError}</p>}
    {ready && <div className="meshy-clips"><button aria-pressed={motion === -1} onClick={() => { viewer.current?.play(-1); setMotion(-1); }}>기본 자세</button>{clips.map(c => <button key={c.index} aria-pressed={motion === c.index} onClick={() => { viewer.current?.play(c.index); setMotion(c.index); }}>{c.name}</button>)}</div>}
    {state?.clips.map(c => <p className="meshy-provenance" key={c.slot}>{motionLabels[c.slot] || c.slot}: {c.source === 'frozen_body' ? '저장된 기본 몸의 동작' : c.source === 'transferred_meshy_rig' ? '저장된 Meshy 골격의 동작 재사용' : c.source === 'rigging_basic' ? 'Meshy 리깅에 포함된 기본 동작' : `Meshy 선택 동작 #${c.action_id}`}</p>)}
    {state?.artifacts.map(a => <a className="meshy-download" key={a.name} href={a.url} download>{a.name === 'model.glb' ? 'Meshy 골격·동작 통합 GLB' : `Meshy 원본 ${a.name}`}</a>)}
    {(state?.status === 'submission_uncertain' || state?.actions.some(a => a.status === 'submission_uncertain')) && <form onSubmit={e => {e.preventDefault(); void perform(() => factoryApi.meshyRecover(jobId, recoveryId, state.actions.find(a => a.status === 'submission_uncertain')?.action_id), '작업 ID를 복구했습니다. 기존 작업 이어가기를 누르세요.');}}><label>Meshy에서 확인한 기존 작업 ID<input aria-label="Meshy 기존 작업 ID" value={recoveryId} onChange={e => setRecoveryId(e.target.value)} required pattern="[a-zA-Z0-9_-]+" /></label><button disabled={running}>기존 작업 ID 복구</button></form>}
    <fieldset disabled={busy || defaultsLoading} className="meshy-picker"><legend>Meshy 동작을 하나씩 공통 기본값으로 지정</legend>
      <p>공식 목록 {library.length}개 · 공통 기본값 저장은 생성 요청을 보내지 않습니다. 선택한 동작만 이 캐릭터로 가져올 수 있습니다.</p>
      {catalogError && <p role="alert">{catalogError}<button onClick={() => void loadLibrary()}>동작 목록 다시 연결</button></p>}
      {defaultsError && <p role="alert">{defaultsError}<button onClick={() => void loadDefaults()}>기본값 다시 불러오기</button></p>}
      <div className="meshy-filters"><label>동작 슬롯<select aria-label="기본 동작 슬롯" value={slot} onChange={e => { setSlot(e.target.value); setActionId(defaults[e.target.value]); setNotice(''); }}>{visibleSlots.map(key => <option key={key} value={key}>{motionLabels[key] || key} ({key})</option>)}</select></label>
        <label>검색<input aria-label="Meshy 동작 검색" value={search} onChange={e => setSearch(e.target.value)} placeholder="이름 또는 action ID" /></label>
        <label>분류<select aria-label="Meshy 동작 분류" value={category} onChange={e => setCategory(e.target.value)}><option value="">전체</option>{Array.from(new Set(library.map(a => a.category))).map(value => <option key={value}>{value}</option>)}</select></label>
      </div>
      <div className="meshy-options"><label>실제 Meshy 동작<select size={8} aria-label="Meshy 동작 목록" value={actionId ?? ''} onChange={e => setActionId(Number(e.target.value))}>{!chosen && <option value="" disabled>동작을 선택하세요</option>}{chosen && !filtered.includes(chosen) && <option value={chosen.action_id}>{chosen.name} · #{chosen.action_id}</option>}{filtered.map(a => <option key={a.action_id} value={a.action_id}>{a.name} · #{a.action_id}</option>)}</select></label>
        <div className="meshy-action-preview">{chosen ? <><strong>{chosen.name} · #{chosen.action_id}</strong>{chosen.preview_url && <img loading="lazy" decoding="async" src={chosen.preview_url} alt={`${chosen.name} Meshy 동작 미리보기`} />}<small>{chosen.category} / {chosen.sub_category}</small></> : <p>목록에서 고르면 Meshy 미리보기가 표시됩니다.</p>}</div>
      </div>
      <div className="meshy-buttons"><button disabled={!chosen} onClick={() => void saveDefault()}>이 동작을 {motionLabels[slot]} 공통 기본값으로 저장</button>
        <button disabled={!chosen || !state?.can_request_action || running} onClick={() => void perform(() => factoryApi.meshyAction(jobId, slot, actionId!), '선택한 Meshy 동작을 가져오고 있습니다.')}>{pending ? '이 동작 조회·적용' : '이 캐릭터에 동작 가져오기 · 유료 최대 1회'}</button></div>
      {pending && <p>선택 동작 상태: {pending.status || '대기'}{pending.task_id ? ` · ${pending.task_id}` : ''}</p>}
      <p>저장한 공통 기본값: {visibleSlots.filter(key => defaults[key] != null).map(key => `${motionLabels[key] || key}: ${library.find(a => a.action_id === defaults[key])?.name || '#'+defaults[key]}`).join(' / ') || (defaultsLoading ? '불러오는 중' : defaultsError ? '조회 실패' : '아직 지정하지 않음')}</p>
      {notice && <p role="status">{notice}</p>}
    </fieldset>
  </section>;
}
