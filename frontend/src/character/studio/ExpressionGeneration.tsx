import { useCallback, useEffect, useRef, useState } from 'react';
import { usePolling } from '../use-polling';
import { expressionNames, type ExpressionName } from '../texture-expressions';
import {
  expressionGenerationApi,
  type ExpressionBatch,
  type ExpressionGeneration as ExpressionGenerationRecord,
} from './expression-generation-api';

const statusLabels: Record<ExpressionGenerationRecord['status'], string> = {
  accepted: '접수됨', running: '생성 중', paused: '일시 중단', blocked: '중단됨', complete: '완료',
};
function upsert(items: ExpressionGenerationRecord[] | undefined, item: ExpressionGenerationRecord) {
  return [item, ...(items || []).filter(current => current.id !== item.id)];
}
function upsertBatch(items: ExpressionBatch[] | undefined, item: ExpressionBatch) {
  return [item, ...(items || []).filter(current => current.id !== item.id)];
}

export function ExpressionGenerationPanel({ job, version, ready, onApply }: {
  job: string;
  version: string;
  ready: boolean;
  onApply: (item: ExpressionGenerationRecord) => Promise<void>;
}) {
  const read = useCallback((signal: AbortSignal) => expressionGenerationApi.list(job, version, signal), [job, version]);
  const listing = usePolling(read, 5000);
  const [name, setName] = useState<ExpressionName>('neutral');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), alive = useRef(true), scope = useRef(`${job}:${version}`);
  scope.current = `${job}:${version}`;
  const recovery = expressionGenerationApi.recovery(job, version), pending = recovery.pending;
  const batchRecovery = expressionGenerationApi.batchRecovery(job, version), batchPending = batchRecovery.pending;
  const defaultPrompt = listing.value?.defaults[name] || '';
  const capability = listing.value?.capabilities;
  const reference = listing.value?.reference, referenceAssets = reference?.assets || [];
  const referenceIds = referenceAssets.map(asset => asset.id);
  const generating = !!listing.value?.batches?.some(item => ['accepted', 'running'].includes(item.status))
    || !!listing.value?.items.some(item => ['accepted', 'running'].includes(item.status));
  const inputLocked = busy || generating || !!pending || !!batchPending || !!recovery.error || !!batchRecovery.error;
  const currentScope = () => alive.current && scope.current === `${job}:${version}`;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    setName('neutral'); setError('');
    locked.current = false; setBusy(false);
  }, [job, version]);
  useEffect(() => {
    if (!pending) return;
    setName(pending.input.name);
  }, [pending?.key]);

  async function perform(action: () => Promise<void>) {
    if (locked.current) return;
    const requestedScope = scope.current;
    locked.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (cause) { if (alive.current && scope.current === requestedScope) setError((cause as Error).message); }
    finally { if (alive.current && scope.current === requestedScope) { locked.current = false; setBusy(false); } }
  }
  async function saveReference(assets: string[]) {
    if (!reference) throw new Error('표정 원본 정보를 불러온 뒤 다시 시도해 주세요.');
    const saved = await expressionGenerationApi.saveReference(job, version, assets, reference.revision);
    if (currentScope()) listing.setValue(previous => previous && ({ ...previous, reference: saved }));
  }
  async function uploadReferences(selected: File[]) {
    if (!selected.length) return;
    if (referenceAssets.length + selected.length > 3) throw new Error('표정 원본은 최대 3장까지 저장할 수 있습니다.');
    if (selected.some(file => file.type !== 'image/png' && !/\.png$/i.test(file.name))) throw new Error('표정 원본은 PNG 파일만 사용할 수 있습니다.');
    if (selected.some(file => file.size > 32 * 1024 * 1024)) throw new Error('표정 원본은 파일당 32MB 이하여야 합니다.');
    const uploaded: string[] = [];
    for (const file of selected) uploaded.push((await expressionGenerationApi.uploadReference(file)).id);
    await saveReference([...referenceIds, ...uploaded]);
  }
  const canCreate = ready && referenceIds.length > 0 && !!capability?.ready && !!defaultPrompt.trim() && !inputLocked;
  const canSubmit = ready && !busy && !recovery.error && (!!pending || canCreate);
  const canCreateBatch = ready && referenceIds.length > 0 && !!capability?.ready && !inputLocked;
  const canSubmitBatch = ready && !busy && !batchRecovery.error && (!!batchPending || canCreateBatch);

  return <section className="expression-generation" aria-busy={busy}>
    <fieldset>
      <legend>표정 텍스처 생성</legend>
      <div className="expression-reference">
        <strong>눈·코·입 원본</strong>
        <div className="expression-reference-assets">{referenceAssets.map((asset, index) => <figure key={asset.id}>
          <img src={asset.url} alt={referenceAssets.length === 1 ? '눈·코·입 원본' : referenceAssets.length === 2 ? index === 0 ? '눈 원본' : '입 원본' : index === 0 ? '눈 원본' : index === 1 ? '코 원본' : '입 원본'} loading="lazy" decoding="async" />
          <figcaption>{referenceAssets.length === 1 ? '눈·코·입' : referenceAssets.length === 2 ? index === 0 ? '눈' : '입' : index === 0 ? '눈' : index === 1 ? '코' : '입'}</figcaption>
          <button type="button" disabled={inputLocked} onClick={() => void perform(() => saveReference(referenceIds.filter(id => id !== asset.id)))}>삭제</button>
        </figure>)}</div>
        <label className="expression-reference-upload">PNG 추가<input type="file" accept="image/png" multiple disabled={inputLocked || !reference || referenceAssets.length >= 3} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void perform(() => uploadReferences(files)); }} /></label>
        <small>눈·코·입을 담은 PNG 1장, 기존 눈·입 순서 PNG 2장, 또는 눈·코·입 순서 PNG 3장 · 파일당 최대 32MB</small>
      </div>
      <label>표정<select value={pending?.input.name || name} disabled={!ready || inputLocked} onChange={event => setName(event.target.value as ExpressionName)}>
        {Object.entries(expressionNames).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select></label>
      <a className="prompt-management-link" href="/?tab=prompts&promptGroup=expression" target="_blank" rel="noreferrer">프롬프트 관리 열기</a>
      <div className="meshy-buttons">
        <button type="button" disabled={!canSubmit} onClick={() => void perform(async () => {
          const input = pending?.input || { name, prompt: defaultPrompt.trim(), reference_assets: referenceIds };
          const result = await expressionGenerationApi.create(job, version, input);
          if (currentScope()) listing.setValue(previous => previous && ({ ...previous, items: upsert(previous.items, result) }));
        })}>{busy ? '요청 확인 중' : pending ? '같은 요청 복구' : '표정 텍스처 생성 · 이미지 1회'}</button>
        <button type="button" disabled={!canSubmitBatch} onClick={() => void perform(async () => {
          const input = batchPending?.input || { reference_assets: referenceIds };
          const result = await expressionGenerationApi.createBatch(job, version, input);
          if (currentScope()) listing.setValue(previous => previous && ({ ...previous, batches: upsertBatch(previous.batches, result) }));
        })}>{busy ? '요청 확인 중' : batchPending ? '기본 5종 같은 요청 복구' : '기본 5종 생성 · 이미지 5회'}</button>
      </div>
      {capability && !capability.ready && <small>{capability.reason || '현재 표정 텍스처를 생성할 수 없습니다.'}</small>}
      {pending && <small>응답을 확인하지 못한 요청입니다. 같은 요청 키로 결과를 복구합니다.</small>}
      {batchPending && <small>응답을 확인하지 못한 기본 5종 요청입니다. 같은 요청 키로 결과를 복구합니다.</small>}
    </fieldset>
    {(error || recovery.error || batchRecovery.error || listing.error) && <p role="alert">{error || recovery.error || batchRecovery.error || listing.error} <button type="button" onClick={() => void listing.refresh()}>다시 불러오기</button></p>}
    {!!listing.value?.batches?.length && <div className="expression-batches">{listing.value.batches.map(batch => <article key={batch.id}>
      <div><strong>기본 5종</strong><small>{statusLabels[batch.status]}</small></div>
      <small>{batch.items.map(item => `${expressionNames[item.name]} ${statusLabels[item.status as keyof typeof statusLabels] || '대기'}`).join(' · ')}</small>
      {batch.error && <p role="alert">{batch.error}</p>}
      {batch.can_resume && <button type="button" disabled={!ready || busy} onClick={() => void perform(async () => {
        const result = await expressionGenerationApi.resumeBatch(job, version, batch.id);
        if (currentScope()) listing.setValue(previous => previous && ({ ...previous, batches: upsertBatch(previous.batches, result) }));
      })}>계속 진행</button>}
    </article>)}</div>}
    <div className="expression-library">
      {listing.value?.items.map(item => {
        const face = item.artifacts.find(artifact => artifact.name === 'face.png');
        return <article key={item.id}>
          {face && <img src={face.url} alt={`${expressionNames[item.name]} 표정 텍스처`} loading="lazy" decoding="async" />}
          <div><strong>{expressionNames[item.name]}</strong><small>{statusLabels[item.status]}</small></div>
          {item.error && <p role="alert">{item.error}</p>}
          <div className="meshy-buttons">
            {item.can_resume && <button type="button" disabled={!ready || busy} onClick={() => void perform(async () => {
              const result = await expressionGenerationApi.resume(job, version, item.id);
              if (currentScope()) listing.setValue(previous => previous && ({ ...previous, items: upsert(previous.items, result) }));
            })}>계속 진행</button>}
            {item.status === 'complete' && face && <button type="button" disabled={!ready || busy} onClick={() => void perform(() => onApply(item))}>얼굴에 적용</button>}
            {face && <a href={face.url} download>PNG</a>}
          </div>
        </article>;
      })}
      {!listing.loading && !listing.value?.items.length && <p>생성한 표정 텍스처가 없습니다.</p>}
    </div>
  </section>;
}
