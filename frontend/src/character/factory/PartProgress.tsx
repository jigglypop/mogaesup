import { useRef, useState } from 'react';
import { factoryApi, type FactoryJob } from './api';
import { partLabels as labels, variantSlots } from './parts';

const viewLabels: Record<string, string> = { front: '정면', side: '좌측면', back: '후면', opposite: '우측면' };

export function PartProgress({ job, busy, retryImage }: { job: FactoryJob; busy: boolean; retryImage: (slot: string, view: string, failureId: string) => Promise<void> }) {
  const [refitting, setRefitting] = useState(''), [refitError, setRefitError] = useState('');
  const [retrying, setRetrying] = useState(false), [retryError, setRetryError] = useState('');
  const refitLock = useRef(false), retryLock = useRef(false);
  async function retry(slot: string, view: string, failureId: string) {
    if (retryLock.current) return;
    retryLock.current = true; setRetrying(true); setRetryError('');
    try { await retryImage(slot, view, failureId); }
    catch (error) { setRetryError((error as Error).message); }
    finally { retryLock.current = false; setRetrying(false); }
  }
  let pending: ReturnType<typeof factoryApi.pendingRefit> = null, recoveryError = '';
  try { pending = factoryApi.pendingRefit(job.id); } catch (error) { recoveryError = (error as Error).message; }
  async function refit(slot: string, method?: 'isolated' | 'body_shell') {
    const version = pending?.input.source_version || job.assembly_version;
    if (refitLock.current || !version) return;
    refitLock.current = true; setRefitting(slot); setRefitError('');
    try { await factoryApi.refitPart(job.id, version, slot, undefined, method); }
    catch (error) { setRefitError((error as Error).message); }
    finally { refitLock.current = false; setRefitting(''); }
  }
  const parts = job.parts || [];
  const imageStates = parts.flatMap(p => Object.values(p.views || {}).length ? Object.values(p.views!) : [{status: p.image_status}]);
  const images = imageStates.filter(image => ['received', 'succeeded', 'qc_failed'].includes(image.status)).length;
  const models = parts.filter(p => p.model_status === 'ready').length;
  const imageNames: Record<string, string> = { pending: '대기', not_sent: '연결 실패', submitting: '응답 대기', received: '수신 · 저장 중', succeeded: '수신 완료', submission_uncertain: '연결 끊김', rejected: '요청 거부', failed: '처리 실패', qc_failed: '수신 · 처리 대기' };
  const modelNames: Record<string, string> = { pending: '대기', PENDING: '접수됨', IN_PROGRESS: '생성 중', SUCCEEDED: '다운로드 중', ready: '파일 수신 완료', submission_uncertain: '응답 확인 필요', submission_rejected: '요청 거부', submission_not_sent: '전송 실패', FAILED: '실패', CANCELED: '취소됨' };
  const assemblyNames = { pending: '대기', running: '진행 중', failed: '중단', complete: '완료' };
  return <section className="character-progress" aria-label="파츠 수신 현황">
    <h2>파츠 수신 현황</h2>
    <p role="status">수신 이미지 {images}/{imageStates.length} · 3D {models}/{parts.length}</p>
    {(refitError || recoveryError || retryError) && <p role="alert">{refitError || recoveryError || retryError}</p>}
    <ul>{parts.map(part => {
      const views = Object.keys(part.views || {});
      const assets = views.length ? views.flatMap(view => {
        const asset = job.artifacts.find(a => a.name === `${part.slot}-${view}.png`);
        return asset ? [{ ...asset, label: viewLabels[view] || view }] : [];
      }) : job.artifacts.filter(a => a.name === `${part.slot}-image.png`).map(a => ({ ...a, label: '이미지' }));
      const model = job.artifacts.find(a => a.name === `generated-${part.slot}.glb`);
      return <li key={part.slot} data-part-slot={part.slot}>
        {assets.length > 0 && <div className="part-view-images">{assets.map(asset => <a key={asset.name} href={asset.url} target="_blank" rel="noreferrer"><img src={asset.url} alt={`${labels[part.slot] || part.slot} ${asset.label}`} loading="lazy" /><span>{asset.label}</span></a>)}</div>}
        <div><strong>{labels[part.slot] || part.slot}</strong>
          {part.reused && <span>저장된 파츠 재사용</span>}
          {!Object.keys(part.views || {}).length && <span>이미지 · {imageNames[part.image_status] || part.image_status}</span>}
          {Object.entries(part.views || {}).map(([view, image]) => {
            const action = job.next_actions?.find(a => a.id === 'retry_image' && a.enabled && a.slot === part.slot && a.view === view);
            return <div className="part-view" key={view}>
              <span>{viewLabels[view] || view} · {image.status === 'rejected' && image.failure?.message ? image.failure.message : imageNames[image.status] || image.status}</span>
              {action?.failure_id && <button className="part-retry" disabled={busy || retrying} onClick={() => void retry(part.slot, view, action.failure_id!)}>{busy || retrying ? '접수 중' : '다시 요청 · 유료 1장'}</button>}
            </div>;
          })}
          <span>3D · {part.part_method === 'body_shell' ? '몸에 맞춰 만듦' : modelNames[part.model_status] || part.model_status}{part.model_status === 'IN_PROGRESS' && ` ${part.progress || 0}%`}</span>
          {part.assembly_status && <span>{part.reused ? '조립' : '피팅·조립'} · {assemblyNames[part.assembly_status]}</span>}
          {part.model_status === 'ready' && views.length > 0 && !views.includes('back') && <span>후면 이미지 없음</span>}
          {model && <a href={model.url} download>파츠 GLB</a>}
          {job.artifacts.filter(artifact => artifact.name.startsWith(`meshy-${part.slot}-`)).map(artifact => <a key={artifact.name} href={artifact.url} download>{artifact.name.slice(`meshy-${part.slot}-`.length)}</a>)}
          {job.meshy_options?.[part.slot] && <details><summary>접수한 Meshy 7.1 설정</summary><pre className="meshy-saved-options">{JSON.stringify(job.meshy_options[part.slot], null, 2)}</pre></details>}
          {job.assembly_version && variantSlots.some(slot => slot === part.slot) && part.model_status === 'ready' && !busy && !job.character_flow?.busy && <a href={`/?${new URLSearchParams({ tab: 'character', mode: 'parts', base: job.id, part: part.slot })}`}>3뷰로 다시 생성</a>}
          {part.slot !== 'body' && part.model_status === 'ready' && part.part_method !== 'body_shell' && (job.assembly_version || pending?.input.slot === part.slot) && <button type="button" disabled={busy || !!refitting || !!recoveryError || (!!pending && pending.input.slot !== part.slot) || (!pending && job.character_flow?.busy)} onClick={() => void refit(part.slot, pending?.input.slot === part.slot ? pending.input.part_method : undefined)}>{refitting === part.slot ? '접수 중' : pending?.input.slot === part.slot ? '같은 피팅 요청 복구' : '기존 모델 위치·크기 맞추기'}</button>}
          {(part.slot === 'top' || part.slot === 'bottom') && part.model_status === 'ready' && job.assembly_version && !pending && <button type="button" disabled={busy || !!refitting || !!recoveryError || job.character_flow?.busy} onClick={() => void refit(part.slot, 'body_shell')}>{refitting === part.slot ? '접수 중' : '몸에 맞춰 다시 만들기'}</button>}
        </div>
      </li>;
    })}</ul>
    <small>작업 {job.id}</small>
  </section>;
}
