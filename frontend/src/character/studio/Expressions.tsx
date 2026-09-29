import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelViewer } from '../viewer';
import { expressionNames, type ExpressionName } from '../texture-expressions';
import { studioApi, type Expression } from './api';
import { usePolling } from '../use-polling';
import { ExpressionGenerationPanel } from './ExpressionGeneration';
import { expressionGenerationApi } from './expression-generation-api';
import './expressions.css';

function expressionKey(record: Expression) {
  return `${record.id}:${record.materials.map(item => `${item.material}:${record.artifacts.find(a => a.name === item.file)?.sha256}`).sort().join('|')}`;
}

function expressionMaps(record: Expression) {
  if (!record.materials.length) throw new Error('저장된 표정 텍스처가 없습니다.');
  return record.materials.map(item => {
    const artifact = record.artifacts.find(current => current.name === item.file);
    if (!artifact?.sha256) throw new Error('저장된 표정 텍스처를 확인할 수 없습니다.');
    return { material: item.material, url: artifact.url, sha256: artifact.sha256 };
  });
}

export function Expressions({ job, version, bodySha, viewer }: {
  job: string; version: string; bodySha: string; viewer: ModelViewer | null;
}) {
  const ready = viewer !== null;
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [activeId, setActiveId] = useState<string | null>(null);
  const [overlayName, setOverlayName] = useState<ExpressionName>('neutral');
  const applied = useRef<{ viewer: ModelViewer; key: string } | null>(null);
  const locked = useRef(false), alive = useRef(true), operation = useRef(0);
  const read = useCallback((signal: AbortSignal) => studioApi.expressions(job, version, signal), [job, version]);
  const saved = usePolling(read, 5000);
  const failed = useRef<{ viewer: ModelViewer; library: typeof saved.value } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current++; }; }, []);
  useEffect(() => {
    applied.current = null; failed.current = null; locked.current = false; setBusy(false); setActiveId(null);
    return () => { operation.current++; };
  }, [viewer]);

  async function perform(action: (token: number) => Promise<void>) {
    if (!viewer || locked.current) return;
    const token = ++operation.current;
    locked.current = true; failed.current = null; setBusy(true); setError('');
    try { await action(token); }
    catch (e) {
      if (alive.current && token === operation.current) {
        failed.current = { viewer, library: saved.value };
        setError((e as Error).message);
      }
    }
    finally { if (alive.current && token === operation.current) { locked.current = false; setBusy(false); } }
  }
  async function select(record: Expression) {
    const selection = await studioApi.selectExpression(job, version, record.id, saved.value?.revision || '0');
    if (!alive.current) return;
    saved.setValue(current => ({ ...current, items: [record, ...(current?.items || []).filter(r => r.id !== record.id)], ...selection }));
  }
  async function applyRecord(record: Expression, persist: boolean, token: number) {
    const instance = viewer;
    if (!instance || !alive.current || token !== operation.current) return;
    const didApply = await instance.savedExpression(expressionMaps(record));
    if (!didApply || !alive.current || token !== operation.current) return;
    applied.current = { viewer: instance, key: expressionKey(record) };
    setActiveId(record.id);
    if (persist) await select(record);
  }
  async function restore(record: Expression, persist = true) {
    await perform(token => applyRecord(record, persist, token));
  }
  useEffect(() => {
    if (!viewer || !saved.value || locked.current) return;
    // Retry failed downloads on the next bounded poll, not on every busy change.
    if (failed.current?.viewer === viewer && failed.current.library === saved.value) return;
    const current = saved.value.items.find(item => item.id === saved.value!.selected && item.materials.length)
      || (saved.value.revision === '0' ? saved.value.items.find(item => item.name === 'neutral' && item.materials.length) : undefined);
    const key = current ? expressionKey(current) : 'none';
    if (applied.current?.viewer === viewer && applied.current.key === key) return;
    // A new viewer or changed/repaired selection must receive the atlas again.
    if (current) void restore(current, false);
    else {
      void perform(async token => {
        if (await viewer.clearExpression() && alive.current && token === operation.current) {
          setActiveId(null); applied.current = { viewer, key };
        }
      });
    }
  }, [viewer, saved.value, busy]);
  const active = saved.value?.items.find(record => record.id === activeId);
  const surface = active?.materials[0];
  const layers = active && surface ? [
    { name: surface.base_file, title: '몸 바탕 텍스처' },
    { name: 'face.png', title: '표정 레이어' },
    { name: surface.file, title: '합성 텍스처' },
  ].flatMap(layer => {
    const artifact = active.artifacts.find(item => item.name === layer.name);
    return artifact ? [{ ...layer, artifact }] : [];
  }) : [];
  return <section className="expressions">
    <ExpressionGenerationPanel job={job} version={version} ready={ready && !busy} onApply={async record => {
      const artifact = record.artifacts.find(a => a.name === 'face.png');
      if (!artifact || record.body_sha256 !== bodySha) throw new Error('현재 몸에 맞는 표정 텍스처가 아닙니다.');
      await perform(async token => {
        const result = await studioApi.bakeExpression(job, version, record.id);
        await applyRecord(result, true, token);
      });
    }} />
    <fieldset className="expression-controls" disabled={!ready || busy}><legend>표정 텍스처</legend>
      <div className="expression-overlay-upload">
        <label>표정<select value={overlayName} onChange={event => setOverlayName(event.target.value as ExpressionName)}>{Object.entries(expressionNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>완성 표정 PNG 적용<input type="file" accept="image/png" onChange={event => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (!file) return;
          void perform(async token => {
            if (file.type !== 'image/png' && !/\.png$/i.test(file.name)) throw new Error('표정 텍스처는 PNG 파일만 사용할 수 있습니다.');
            if (file.size > 32 * 1024 * 1024) throw new Error('표정 텍스처는 32MB 이하여야 합니다.');
            const uploaded = await expressionGenerationApi.uploadReference(file);
            if (!uploaded.alpha) throw new Error('투명 배경이 있는 PNG가 필요합니다.');
            const record = await studioApi.applyExpressionOverlay(job, version, { asset_id: uploaded.id, name: overlayName });
            saved.setValue(current => current && ({ ...current, items: [record, ...current.items.filter(item => item.id !== record.id)] }));
            await applyRecord(record, true, token);
          });
        }} /></label>
      </div>
      <button disabled={!activeId} onClick={() => void perform(async token => {
        const selection = await studioApi.selectExpression(job, version, null, saved.value?.revision || '0');
        if (!viewer || !alive.current || token !== operation.current) return;
        if (!await viewer.clearExpression() || !alive.current || token !== operation.current) return;
        setActiveId(null); applied.current = { viewer, key: 'none' };
        saved.setValue(current => current && ({ ...current, ...selection }));
      })}>표정 해제</button>
      {busy && <p role="status">표정 텍스처 적용 중…</p>}
      {layers.length > 1 && <div className="expression-layers">{layers.map(layer => <a key={layer.name} href={layer.artifact.url} download>
        <img src={layer.artifact.url} alt={layer.title} loading="lazy" />{layer.title}
      </a>)}</div>}
      <div className="expression-library">{saved.value?.items.filter(record => record.materials.length).map(record => <article key={record.id}>
        <button aria-pressed={activeId === record.id} onClick={() => void restore(record)}>
          {record.materials[0] && <img src={record.artifacts.find(a => a.name === record.materials[0].file)?.url} alt={`${expressionNames[record.name]} 얼굴 UV 텍스처`} loading="lazy" />}
          {expressionNames[record.name]}{record.id === saved.value?.selected ? ' · 저장된 선택' : ''}
        </button>
        <div>{record.artifacts.filter(a => ['model.glb', 'body.glb'].includes(a.name)).map(a => <a key={a.name} href={a.url} download>{a.name === 'model.glb' ? '캐릭터 GLB' : '몸 GLB'}</a>)}</div>
      </article>)}</div>
    </fieldset>
    {(error || saved.error) && <p role="alert">{error || saved.error} <button onClick={() => void saved.refresh()}>다시 불러오기</button></p>}
  </section>;
}
