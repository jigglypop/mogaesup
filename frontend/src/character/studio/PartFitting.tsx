import { useEffect, useRef, useState } from 'react';
import { factoryApi, type FitAnchor, type FitProfile, type NativePartsState, type NativePartsVersions, type PartFitProfile } from '../factory/api';

type Props = { jobId: string; slot: 'top' | 'bottom'; label: string; rawUrl?: string; onClose: () => void; onPendingSlot: (slot: 'top' | 'bottom') => void };
const anchorNames = {
  top: ['neck', 'torso_attach', 'shoulder_left', 'shoulder_right', 'waist', 'waist_left', 'waist_right', 'cuff_left', 'cuff_right', 'hem', 'hem_left', 'hem_right'],
  bottom: ['waist', 'waist_left', 'waist_right', 'hip_left', 'hip_right', 'crotch', 'hem', 'hem_left', 'hem_right'],
} as const;
function regionEaseOptions() {
  return <><option value="">공통값 사용</option><option value="source">원본대로</option><option value="regular">보통</option><option value="loose">여유 있음</option></>;
}

function anchorsFrom(payload: PartFitProfile): FitAnchor[] {
  if (payload.fit_profile.anchors?.length) return payload.fit_profile.anchors;
  const value = payload.measurement?.anchors;
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const anchor = item as { name?: unknown; source?: unknown; target?: unknown };
    if (typeof anchor.name !== 'string' || !Array.isArray(anchor.source) || anchor.source.length !== 3
      || !anchor.source.every(number => typeof number === 'number')) return [];
    const target = Array.isArray(anchor.target) && anchor.target.length === 3 && anchor.target.every(number => typeof number === 'number')
      ? anchor.target as [number, number, number] : undefined;
    return [{ name: anchor.name, source: anchor.source as [number, number, number], ...(target ? { target } : {}) }];
  });
}

function completionMessage(state: NativePartsState) {
  if (state.status === 'accepted' || state.status === 'running') return '피팅 작업 진행 중';
  if (state.incomplete_parts?.length) return `저장 완료 · 미완성 ${state.incomplete_parts.map(item => item.slot).join(', ')}`;
  if (state.status === 'review_required') return '피팅 버전 저장 완료';
  return state.error || state.fit_status || state.status;
}

export function PartFitting({ jobId, slot, label, rawUrl, onClose, onPendingSlot }: Props) {
  const [versions, setVersions] = useState<NativePartsVersions>();
  const [native, setNative] = useState<NativePartsState>();
  const [sourceVersion, setSourceVersion] = useState('');
  const [restoreVersion, setRestoreVersion] = useState('');
  const [profile, setProfile] = useState<FitProfile>({ revision: 'garment-fit-v1' });
  const [context, setContext] = useState<PartFitProfile>();
  const [loading, setLoading] = useState(true), [profileLoading, setProfileLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const locked = useRef(false), profileSequence = useRef(0), profileController = useRef<AbortController | null>(null);
  let pendingError = '';
  let pending: ReturnType<typeof factoryApi.pendingRefit> = null;
  let restorePending: ReturnType<typeof factoryApi.pendingNativePartsSelection> = null;
  try { pending = factoryApi.pendingRefit(jobId); } catch (reason) { pendingError = (reason as Error).message; }
  try { restorePending = factoryApi.pendingNativePartsSelection(jobId); } catch (reason) { pendingError ||= (reason as Error).message; }
  const foreignPending = pending && pending.input.slot !== slot ? pending : null;
  const ownPending = pending && pending.input.slot === slot ? pending : null;
  const controlsLocked = busy || profileLoading || !!pending || !!restorePending;
  const pollingActive = !!native && ['accepted', 'running'].includes(native.status);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++profileSequence.current;
    profileController.current?.abort(); profileController.current = controller;
    setLoading(true); setProfileLoading(true); setError(''); setNotice('');
    void Promise.all([factoryApi.nativePartsVersions(jobId, controller.signal), factoryApi.nativeParts(jobId, controller.signal)])
      .then(async ([saved, state]) => {
        if (controller.signal.aborted || sequence !== profileSequence.current) return;
        setVersions(saved); setNative(state);
        const savedRefit = factoryApi.pendingRefit(jobId);
        const savedSelection = factoryApi.pendingNativePartsSelection(jobId);
        const applies = savedRefit?.input.slot === slot;
        const version = applies ? savedRefit.input.source_version : saved.current || state.version || '';
        setSourceVersion(version); setRestoreVersion(savedSelection?.input.version || saved.current || version);
        if (!version) throw new Error('피팅할 저장 버전이 없습니다.');
        const result = await factoryApi.fitProfile(jobId, slot, version, controller.signal);
        if (controller.signal.aborted || sequence !== profileSequence.current) return;
        const next = applies && savedRefit?.input.fit_profile ? savedRefit.input.fit_profile : result.fit_profile;
        setContext(result);
        setProfile({ revision: 'garment-fit-v1', ...next, anchors: next.anchors?.length ? next.anchors : anchorsFrom(result) });
      })
      .catch(reason => { if (!controller.signal.aborted && sequence === profileSequence.current) setError((reason as Error).message); })
      .finally(() => {
        if (!controller.signal.aborted && sequence === profileSequence.current) { setLoading(false); setProfileLoading(false); }
      });
    return () => controller.abort();
  }, [jobId, slot]);

  useEffect(() => () => profileController.current?.abort(), []);
  useEffect(() => {
    if (!pollingActive) return;
    const controller = new AbortController();
    let timer = 0;
    const poll = async () => {
      try {
        const [state, saved] = await Promise.all([factoryApi.nativeParts(jobId, controller.signal), factoryApi.nativePartsVersions(jobId, controller.signal)]);
        if (controller.signal.aborted) return;
        setNative(state); setVersions(saved);
        setNotice(completionMessage(state));
        if (['accepted', 'running'].includes(state.status)) timer = window.setTimeout(() => void poll(), 3000);
        else {
          setRestoreVersion(saved.current || '');
          if (saved.current && saved.current !== sourceVersion) void loadProfile(saved.current);
        }
      } catch (reason) {
        if (!controller.signal.aborted) { setError((reason as Error).message); timer = window.setTimeout(() => void poll(), 5000); }
      }
    };
    timer = window.setTimeout(() => void poll(), 3000);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [jobId, pollingActive]);

  async function loadProfile(version: string) {
    const sequence = ++profileSequence.current;
    const previousVersion = sourceVersion;
    profileController.current?.abort();
    const controller = new AbortController(); profileController.current = controller;
    setSourceVersion(version); setProfileLoading(true); setError(''); setNotice('');
    try {
      const result = await factoryApi.fitProfile(jobId, slot, version, controller.signal);
      if (controller.signal.aborted || sequence !== profileSequence.current) return;
      setContext(result); setProfile({ revision: 'garment-fit-v1', ...result.fit_profile, anchors: anchorsFrom(result) });
    } catch (reason) {
      if (!controller.signal.aborted && sequence === profileSequence.current) { setSourceVersion(previousVersion); setError((reason as Error).message); }
    } finally {
      if (!controller.signal.aborted && sequence === profileSequence.current) setProfileLoading(false);
    }
  }
  async function perform(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (reason) { setError((reason as Error).message); }
    finally { locked.current = false; setBusy(false); }
  }
  function numberValue(value: number | null | undefined) { return value == null ? '' : String(value); }
  function setRatio(key: 'length_ratio' | 'sleeve_ratio', value: string) {
    setProfile(current => ({ ...current, [key]: value === '' ? null : Number(value) }));
  }
  function setRegionEase(region: 'torso' | 'sleeve' | 'hip', value: string) {
    setProfile(current => {
      const regionEase = { ...current.region_ease };
      if (value) regionEase[region] = value as 'source' | 'regular' | 'loose';
      else delete regionEase[region];
      return { ...current, region_ease: Object.keys(regionEase).length ? regionEase : undefined };
    });
  }
  function updateAnchor(index: number, update: Partial<FitAnchor>) {
    setProfile(current => ({ ...current, anchors: (current.anchors || []).map((anchor, itemIndex) => itemIndex === index ? { ...anchor, ...update } : anchor) }));
  }
  function setAnchorCoordinate(index: number, axis: 0 | 1 | 2, value: string) {
    const anchor = profile.anchors?.[index];
    if (!anchor) return;
    const source: [number, number, number] = [...anchor.source]; source[axis] = Number(value);
    updateAnchor(index, { source });
  }
  function addAnchor() {
    const used = new Set((profile.anchors || []).map(anchor => anchor.name));
    const name = anchorNames[slot].find(value => !used.has(value)) || anchorNames[slot][0];
    setProfile(current => ({ ...current, anchors: [...(current.anchors || []), { name, source: [0, 0, 0] }] }));
  }
  const fittedUrl = versions?.items.find(item => item.version === versions.current)?.url;
  const sourceIsCurrent = !!sourceVersion && sourceVersion === versions?.current;
  const canRecoverRefit = !!ownPending;
  const canRestore = !!restorePending || (!!restoreVersion && !!versions?.current && restoreVersion !== versions.current);
  const anchorsValid = (profile.anchors || []).every(anchor => !!anchor.name.trim() && anchor.source.every(Number.isFinite));

  return <section className="part-fitting" aria-busy={loading || profileLoading || busy} aria-labelledby="part-fitting-title">
    <div className="part-fitting-heading"><div><h3 id="part-fitting-title">{label} 피팅</h3><small>{jobId}</small></div><button type="button" onClick={onClose}>닫기</button></div>
    {loading ? <p>피팅 정보를 불러오는 중…</p> : <>
      <div className="part-fitting-links">{rawUrl && <a href={rawUrl} target="_blank" rel="noreferrer">원본 이미지</a>}{fittedUrl && <a href={fittedUrl} target="_blank" rel="noreferrer">피팅 이미지</a>}</div>
      {native && <p className="part-fitting-state" role="status">{completionMessage(native)}</p>}
      {!!native?.incomplete_parts?.length && <ul className="part-fitting-incomplete">{native.incomplete_parts.map(item => <li key={`${item.slot}:${item.status}`}><strong>{item.slot}</strong> · {item.status}{item.errors.length ? ` · ${item.errors.map(problem => `${problem.code}: ${problem.message}`).join(', ')}` : ''}</li>)}</ul>}
      {foreignPending && <p className="generation-recovery">{foreignPending.input.slot === 'top' ? '상의' : '하의'} 피팅 요청을 먼저 복구해야 합니다. <button type="button" onClick={() => onPendingSlot(foreignPending!.input.slot as 'top' | 'bottom')}>요청한 파츠 열기</button></p>}
      <label>원본 버전<select value={sourceVersion} disabled={controlsLocked} onChange={event => void loadProfile(event.target.value)}>{versions?.items.map(item => <option key={item.version} value={item.version}>{item.version}{item.version === versions.current ? ' · 현재' : ''}</option>)}</select></label>
      {!sourceIsCurrent && !ownPending && <p className="part-fitting-version-note">과거 버전은 바로 피팅할 수 없습니다. 아래에서 이 버전을 현재 버전으로 전환한 뒤 피팅하세요.</p>}
      <div className="part-fitting-fields">
        {slot === 'top' && <label>소매<select value={profile.sleeve || 'source'} disabled={controlsLocked} onChange={event => setProfile(current => ({ ...current, sleeve: event.target.value as FitProfile['sleeve'] }))}><option value="source">원본대로</option><option value="none">민소매</option><option value="short">반팔</option><option value="long">긴팔</option></select></label>}
        {slot === 'bottom' && <label>종류<select value={profile.kind || 'source'} disabled={controlsLocked} onChange={event => setProfile(current => ({ ...current, kind: event.target.value as FitProfile['kind'] }))}><option value="source">원본대로</option><option value="pants">바지</option><option value="skirt">치마</option></select></label>}
        <label>여유<select value={profile.ease || 'source'} disabled={controlsLocked} onChange={event => setProfile(current => ({ ...current, ease: event.target.value as FitProfile['ease'] }))}><option value="source">원본대로</option><option value="regular">보통</option><option value="loose">여유 있음</option></select></label>
        <label>길이 비율<input type="number" step="0.01" min="0.1" max="3" value={numberValue(profile.length_ratio)} disabled={controlsLocked} onChange={event => setRatio('length_ratio', event.target.value)} placeholder="자동" /></label>
        {slot === 'top' && <label>소매 길이 비율<input type="number" step="0.01" min="0" max="1.5" value={numberValue(profile.sleeve_ratio)} disabled={controlsLocked} onChange={event => setRatio('sleeve_ratio', event.target.value)} placeholder="자동" /></label>}
      </div>
      <details className="part-fitting-advanced"><summary>기준점 보정 · glTF X/Y/Z</summary><div className="part-fitting-anchors">{(profile.anchors || []).map((anchor, index) => <fieldset key={index} disabled={controlsLocked}>
        <label className="part-fitting-anchor-name">이름<input required maxLength={64} list={`${slot}-anchor-names`} value={anchor.name} onChange={event => updateAnchor(index, { name: event.target.value })} /></label>
        {(['X', 'Y', 'Z'] as const).map((axis, axisIndex) => <label key={axis}>{axis}<input type="number" step="0.001" value={anchor.source[axisIndex]} onChange={event => setAnchorCoordinate(index, axisIndex as 0 | 1 | 2, event.target.value)} /></label>)}
        <button type="button" onClick={() => setProfile(current => ({ ...current, anchors: (current.anchors || []).filter((_, itemIndex) => itemIndex !== index) }))}>삭제</button>
      </fieldset>)}<datalist id={`${slot}-anchor-names`}>{anchorNames[slot].map(name => <option key={name} value={name} />)}</datalist><button type="button" disabled={controlsLocked} onClick={addAnchor}>기준점 추가</button></div></details>
      <details className="part-fitting-advanced"><summary>부위별 여유</summary><div className="part-fitting-fields">
        {slot === 'top' && <><label>몸통 여유<select value={profile.region_ease?.torso || ''} disabled={controlsLocked} onChange={event => setRegionEase('torso', event.target.value)}>{regionEaseOptions()}</select></label><label>소매 여유<select value={profile.region_ease?.sleeve || ''} disabled={controlsLocked} onChange={event => setRegionEase('sleeve', event.target.value)}>{regionEaseOptions()}</select></label></>}
        {slot === 'bottom' && <label>골반 여유<select value={profile.region_ease?.hip || ''} disabled={controlsLocked} onChange={event => setRegionEase('hip', event.target.value)}>{regionEaseOptions()}</select></label>}
      </div></details>
      <details className="part-fitting-advanced"><summary>고급 정보</summary><dl><div><dt>원본 SHA-256</dt><dd>{context?.source_sha256 || profile.source_sha256 || '-'}</dd></div><div><dt>규격</dt><dd>{profile.revision || 'garment-fit-v1'}</dd></div></dl></details>
      {ownPending && <small className="generation-recovery">응답이 확인되지 않은 {label} 피팅 요청입니다. 저장된 입력과 요청 키로 복구합니다.</small>}
      <div className="part-fitting-actions"><button type="button" disabled={busy || profileLoading || !anchorsValid || !!foreignPending || !!restorePending || (!canRecoverRefit && !sourceIsCurrent)} onClick={() => void perform(async () => {
        const result = await factoryApi.refitPart(jobId, sourceVersion, slot, profile);
        setNative(result); setNotice(completionMessage(result));
        const saved = await factoryApi.nativePartsVersions(jobId); setVersions(saved); setRestoreVersion(saved.current || result.version || '');
      })}>{busy ? '처리 중' : ownPending ? '같은 피팅 요청 복구' : '새 피팅 버전 저장'}</button></div>
      {!!versions?.items.length && <div className="part-fitting-restore"><label>저장 버전<select value={restorePending?.input.version || restoreVersion} disabled={busy || !!restorePending || !!pending} onChange={event => setRestoreVersion(event.target.value)}>{versions.items.map(item => <option key={item.version} value={item.version}>{item.version}{item.version === versions.current ? ' · 현재' : ''}</option>)}</select></label><button type="button" disabled={busy || !!pending || !canRestore} onClick={() => void perform(async () => {
        const expected = restorePending?.input.expected_version || versions.current;
        if (!expected) throw new Error('현재 피팅 버전을 확인할 수 없습니다.');
        const result = await factoryApi.selectNativePartsVersion(jobId, restorePending?.input.version || restoreVersion, expected);
        setNative(result);
        const saved = await factoryApi.nativePartsVersions(jobId); setVersions(saved); setRestoreVersion(saved.current || '');
        if (saved.current) await loadProfile(saved.current);
        setNotice('저장된 피팅 버전으로 전환했습니다.');
      })}>{restorePending ? '같은 전환 요청 복구' : '이 버전 사용'}</button></div>}
    </>}
    {(error || pendingError) && <p role="alert">{error || pendingError}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
