import { useEffect, useRef, useState } from 'react';
import { factoryApi, type FactoryCapabilities, type FactoryJob, type FitProfile, type NativePartsState, type PartMethod } from '../factory/api';
import { NativeAssembly } from '../factory/NativeAssembly';
import { PartProgress } from '../factory/PartProgress';
import { ProductionProgress } from '../factory/ProductionProgress';
import { StageRunner } from '../factory/StageRunner';
import { partLabels, variantSlots } from '../factory/parts';
import { studioApi } from './api';
import { MeshyOptionsEditor } from './MeshyOptionsEditor';
import { useMeshyOptions, meshyOptionsError } from './meshy-options';
import { HairBatch } from './HairBatch';
import { GlbAssetLibrary } from './GlbAssetLibrary';

const methodOptions: Partial<Record<string, [PartMethod, string][]>> = {
  top: [['worn', '입힌 채 3D 생성'], ['body_shell', '몸에 맞춰 만들기'], ['isolated', '단독 3D 생성']],
  bottom: [['worn', '입힌 채 3D 생성'], ['body_shell', '몸에 맞춰 만들기'], ['isolated', '단독 3D 생성']],
  hair: [['worn', '머리에 씌워 3D 생성'], ['isolated', '단독 3D 생성']],
};

type Props = {
  slot: (typeof variantSlots)[number];
  onSlotChange: (slot: (typeof variantSlots)[number]) => void;
  bases: FactoryJob[];
  base?: FactoryJob;
  native?: NativePartsState;
  versions: FactoryJob[];
  job?: FactoryJob;
  name: (job: FactoryJob) => string;
  onBaseChange: (id: string) => void;
  onJobChange: (id: string) => void;
  onJob: (job: FactoryJob) => void;
  refreshJobs: () => Promise<unknown>;
};

export function SinglePart({ slot, onSlotChange, bases, base, native, versions, job, name, onBaseChange, onJobChange, onJob, refreshJobs }: Props) {
  const [inputMode, setInputMode] = useState<'generate' | 'batch' | 'glb'>(slot === 'hair' ? 'batch' : 'generate');
  const [hairLength, setHairLength] = useState<'source' | 'short' | 'long'>('source');
  const [bottomKind, setBottomKind] = useState<'source' | 'pants' | 'skirt'>('source');
  const [sleeve, setSleeve] = useState<'source' | 'none' | 'short' | 'long'>('source');
  const [ease, setEase] = useState<'source' | 'regular' | 'loose'>('source');
  const [partMethod, setPartMethod] = useState<PartMethod>(methodOptions[slot]?.[0][0] || 'isolated');
  const [provider, setProvider] = useState<'meshy' | 'tripo'>('meshy');
  const [capabilities, setCapabilities] = useState<FactoryCapabilities>();
  const [busy, setBusy] = useState(false);
  const meshy = useMeshyOptions(slot);
  const [meshyUploading, setMeshyUploading] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const recovery = studioApi.singlePartRecovery();
  const pending = recovery.pending;
  const differentPending = !!pending && pending.input.slot !== slot;
  const inputLocked = busy || meshyUploading || !!pending || !!recovery.error;
  const batchMode = slot === 'hair' && inputMode === 'batch' && !pending;

  useEffect(() => { setInputMode(slot === 'hair' ? 'batch' : 'generate'); setPartMethod(methodOptions[slot]?.[0][0] || 'isolated'); }, [slot]);
  useEffect(() => {
    const controller = new AbortController();
    factoryApi.capabilities(controller.signal).then(value => {
      setCapabilities(value);
      if (value.default_model_provider) setProvider(value.default_model_provider);
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!pending) return;
    onBaseChange(pending.input.base_job_id);
    onSlotChange(pending.input.slot as (typeof variantSlots)[number]);
    setHairLength(pending.input.hair_length);
    setBottomKind(pending.input.bottom_kind);
    setSleeve(pending.input.fit_profile?.sleeve || 'source');
    setEase(pending.input.fit_profile?.ease || 'source');
    if (pending.input.part_method) setPartMethod(pending.input.part_method);
    if (pending.input.model_provider) setProvider(pending.input.model_provider);
  }, [pending?.key]);

  async function submit() {
    if (locked.current) return;
    const fitProfile: FitProfile | undefined = slot === 'top' ? { revision: 'garment-fit-v1', sleeve, ease }
      : slot === 'bottom' ? { revision: 'garment-fit-v1', kind: bottomKind, ease } : undefined;
    const input = pending?.input || (base && native?.version ? {
      base_job_id: base.id,
      base_version: native.version,
      slot,
      hair_length: hairLength,
      bottom_kind: bottomKind,
      ...(fitProfile ? { fit_profile: fitProfile } : {}),
      view_mode: 'front_side_back' as const,
      ...(partMethod !== 'body_shell' ? { meshy_options: meshy.options } : {}),
      ...(methodOptions[slot] ? { part_method: partMethod } : {}),
      ...(partMethod !== 'body_shell' && (capabilities?.model_providers?.length || 0) > 1 ? { model_provider: provider } : {}),
    } : undefined);
    if (!input) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      if (input.meshy_options && meshyOptionsError(input.meshy_options)) throw new Error(meshyOptionsError(input.meshy_options));
      const result = await studioApi.singlePart(input);
      onBaseChange(input.base_job_id);
      onJob(result);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  // A finished part result is a valid base: its fitted parts are kept and the new part is added.
  const worn = (item: FactoryJob) => (item.assembly_artifacts || []).map(artifact => artifact.name.replace(/\.glb$/, ''))
    .filter(part => !['body', 'model'].includes(part)).map(part => partLabels[part] || part);
  const baseOptions = [...bases.filter(item => !item.base_job_id), ...bases.filter(item => item.base_job_id)];
  const baseSelector = <label>기준 캐릭터<select value={pending?.input.base_job_id || base?.id || ''} disabled={inputLocked} onChange={event => onBaseChange(event.target.value)}>
    <option value="" disabled>선택</option>
    {pending && !bases.some(item => item.id === pending.input.base_job_id) && <option value={pending.input.base_job_id}>{pending.input.base_job_id}</option>}
    {baseOptions.map(item => <option key={item.id} value={item.id}>{name(item)} · {worn(item).join('·') || '기본 몸'}</option>)}
  </select></label>;
  const baseStatus = pending ? '' : !bases.length ? '완성된 기본 몸 없음 · 기본몸에서 먼저 생성하세요'
    : !base ? '기준 캐릭터를 선택하세요' : native && native.status !== 'review_required' ? '기준 캐릭터 조립 확인 중' : '';
  const outputSettings = <><MeshyOptionsEditor key={slot} scope={slot} value={pending?.input.meshy_options || meshy.options} disabled={inputLocked} onChange={meshy.setOptions} onUploading={setMeshyUploading} />{meshy.storageError && <p role="alert">{meshy.storageError}</p>}</>;

  return <main className={batchMode ? 'single-part-batch-layout' : undefined}>
    <section className="character-input single-part-flow">
      <h1>{partLabels[slot]}</h1>
      <div className="character-workflow-switch" role="group" aria-label="파츠 입력 방식">{slot === 'hair' && <button aria-pressed={batchMode} disabled={inputLocked} onClick={() => setInputMode('batch')}>시트·여러 헤어</button>}<button aria-pressed={inputMode === 'generate' || !!pending} disabled={inputLocked} onClick={() => setInputMode('generate')}>하나 생성</button><button aria-pressed={inputMode === 'glb' && !pending} disabled={inputLocked} onClick={() => setInputMode('glb')}>GLB 등록</button></div>
      {inputMode === 'glb' && !pending ? <GlbAssetLibrary key={slot} slot={slot} bases={bases} defaultBaseId={base?.id} onJob={result => { onBaseChange(result.base_job_id || result.id); onJob(result); void refreshJobs(); }} /> : <>
      {differentPending && <p className="generation-recovery">{partLabels[pending!.input.slot]} 요청 확인이 필요합니다. <button type="button" onClick={() => onSlotChange(pending!.input.slot as (typeof variantSlots)[number])}>해당 파츠 열기</button></p>}
      {!batchMode && baseSelector}
      {!batchMode && native?.artifacts.find(artifact => artifact.name === 'body-front.png') && <img className="base-portrait" src={native.artifacts.find(artifact => artifact.name === 'body-front.png')!.url} alt="선택한 캐릭터" />}
      {slot === 'hair' && !batchMode && <label>헤어 길이<select value={hairLength} disabled={inputLocked} onChange={event => setHairLength(event.target.value as typeof hairLength)}><option value="source">저장된 기준</option><option value="short">숏컷</option><option value="long">롱컷</option></select></label>}
      {slot === 'top' && <label>소매<select value={sleeve} disabled={inputLocked} onChange={event => setSleeve(event.target.value as typeof sleeve)}><option value="source">원본대로</option><option value="none">민소매</option><option value="short">반팔</option><option value="long">긴팔</option></select></label>}
      {slot === 'bottom' && <label>하의 종류<select value={bottomKind} disabled={inputLocked} onChange={event => setBottomKind(event.target.value as typeof bottomKind)}><option value="source">저장된 기준</option><option value="pants">바지</option><option value="skirt">치마</option></select></label>}
      {(slot === 'top' || slot === 'bottom') && <label>여유<select value={ease} disabled={inputLocked} onChange={event => setEase(event.target.value as typeof ease)}><option value="source">원본대로</option><option value="regular">보통</option><option value="loose">여유 있음</option></select></label>}
      {!batchMode && methodOptions[slot] && <label>만드는 방식<select value={pending?.input.part_method || partMethod} disabled={inputLocked} onChange={event => setPartMethod(event.target.value as PartMethod)}>{methodOptions[slot]!.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
      {!batchMode && partMethod !== 'body_shell' && (capabilities?.model_providers?.length || 0) > 1 && <label>3D 제공자<select value={pending?.input.model_provider || provider} disabled={inputLocked} onChange={event => setProvider(event.target.value as 'meshy' | 'tripo')}>{capabilities!.model_providers!.map(value => <option key={value} value={value}>{value === 'tripo' ? 'Tripo' : 'Meshy'}</option>)}</select></label>}
      {!batchMode && <a className="prompt-management-link" href="/?tab=prompts&promptGroup=parts" target="_blank" rel="noreferrer">프롬프트 관리</a>}
      {!batchMode && partMethod !== 'body_shell' && (pending?.input.model_provider || provider) === 'meshy' && outputSettings}
      {batchMode && <HairBatch baseId={base?.id} version={native?.version} disabled={inputLocked} setup={baseSelector} onJob={result => { onBaseChange(result.base_job_id || result.id); onJob(result); setInputMode('generate'); }} />}
      {(error || recovery.error) && <p role="alert">{error || recovery.error}</p>}
      {!batchMode && <><button className="character-create" disabled={busy || meshyUploading || differentPending || !!recovery.error || (!pending && (!base || native?.status !== 'review_required' || !native.version))} onClick={() => void submit()}>{busy ? '접수 중' : pending ? '기존 요청 복구' : `${partLabels[slot]} 하나 생성`}</button>
      <small>유료 이미지 {pending && pending.input.view_mode !== 'front_side_back' ? '2장' : '3장'} · {(pending?.input.part_method || partMethod) === 'body_shell' ? '3D 없음' : '3D 1개'}</small>
      {baseStatus && <p role="status">{baseStatus}</p>}</>}
      </>}
      {job && !batchMode && <><label>결과 버전<select value={job.id} onChange={event => onJobChange(event.target.value)}>{versions.map(item => <option key={item.id} value={item.id}>{item.id === base?.id ? `${name(item)} · 기준 캐릭터` : `${name(item)} · ${item.requested_slots?.map(value => partLabels[value] || value).join(', ') || '파츠'}`}</option>)}</select></label><PartProgress job={job} busy={busy} retryImage={async (part, view, failureId) => { await factoryApi.retryImages(job.id, [{ slot: part, view, failure_id: failureId }]); await refreshJobs(); }} /></>}
    </section>
    {!batchMode && <section className="character-result">{job ? <><ProductionProgress job={job} offline={false} /><StageRunner jobId={job.id} key={`stage-${job.id}`} onChange={() => void refreshJobs()} /><NativeAssembly key={job.id} jobId={job.id} simple flow={job.character_flow} /></> : <div className="character-empty">저장된 캐릭터 없음</div>}</section>}
  </main>;
}
