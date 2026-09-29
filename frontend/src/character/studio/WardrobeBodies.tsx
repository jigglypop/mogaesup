import { useRef, useState } from 'react';
import { factoryApi, type FactoryJob, type WardrobeBody } from '../factory/api';
import { usePolling } from '../use-polling';

type Props = { jobs: FactoryJob[]; selectedJob?: FactoryJob; onSelect: (job: FactoryJob) => void };
const bodyLabels: Record<string, string> = { male: '남성형', female: '여성형' };

function renderUrl(body: WardrobeBody, name: string) {
  return `/api/avatar-factory/jobs/${body.job_id}/native-parts/${body.version}/${name}`;
}

function BodyRender({ body }: { body: WardrobeBody }) {
  // body-front.png shows the body alone; versions without it fall back to the assembly render.
  const [fallback, setFallback] = useState(false);
  return <img src={renderUrl(body, fallback ? 'front.png' : 'body-front.png')} alt={`${body.name} 몸`} loading="lazy"
    onError={() => { if (!fallback) setFallback(true); }} />;
}

export function WardrobeBodies({ jobs, selectedJob, onSelect }: Props) {
  const wardrobe = usePolling(factoryApi.wardrobeBodies, 15000);
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const locked = useRef(false);
  const state = wardrobe.value;
  const registered = new Map(state?.bodies.map(body => [body.job_id, body]) || []);
  const selectedEntry = selectedJob ? registered.get(selectedJob.id) : undefined;
  const canRegister = !!selectedJob?.assembly_version && !selectedJob.base_job_id && selectedJob.assembly_origin !== 'uploaded_glb'
    && (!selectedEntry || selectedEntry.version !== selectedJob.assembly_version);

  async function perform(key: string, action: () => Promise<unknown>) {
    if (locked.current) return;
    locked.current = true; setBusy(key); setError('');
    try { await action(); } catch (reason) { setError((reason as Error).message); }
    finally { locked.current = false; setBusy(''); await wardrobe.refresh(); }
  }
  const register = (job: FactoryJob) => perform(`register:${job.id}`, async () => {
    wardrobe.setValue(await factoryApi.registerWardrobeBody(job.id, job.assembly_version!, state!.revision));
  });
  const unregister = (body: WardrobeBody) => perform(`remove:${body.job_id}`, async () => {
    wardrobe.setValue(await factoryApi.unregisterWardrobeBody(body.job_id, state!.revision));
  });
  const makeDefault = (body: WardrobeBody) => perform(`default:${body.job_id}`, async () => {
    const profile = await factoryApi.bodyProfile();
    await factoryApi.saveBodyProfile(body.job_id, body.version, profile.revision);
  });

  return <section className="wardrobe-bodies" aria-busy={!!busy}>
    <div className="wardrobe-bodies-heading">
      <h2>옷장 몸</h2>
      {selectedJob && canRegister && <button type="button" disabled={!!busy || !state} onClick={() => void register(selectedJob)}>
        {busy === `register:${selectedJob.id}` ? '등록 중' : selectedEntry ? `${selectedJob.character_name} 현재 버전으로 교체` : `${selectedJob.character_name} 등록`}
      </button>}
    </div>
    {state && state.bodies.length === 0 && <p className="wardrobe-bodies-empty">등록된 옷장 몸이 없습니다.</p>}
    {state && state.bodies.length > 0 && <div className="wardrobe-body-list">{state.bodies.map(body => {
      const job = jobs.find(item => item.id === body.job_id);
      const stale = !!job?.assembly_version && job.assembly_version !== body.version;
      return <article key={body.job_id} className={`wardrobe-body ${selectedJob?.id === body.job_id ? 'selected' : ''}`}>
        <button type="button" className="wardrobe-body-select" disabled={!job?.base_body?.body_type} onClick={() => job && onSelect(job)}>
          <BodyRender body={body} />
          <strong>{body.name}</strong>
          <small>{bodyLabels[body.body_type || ''] || '체형 미지정'} · {body.version.slice(0, 8)}{body.part_jobs != null && ` · 파츠 작업 ${body.part_jobs}개`}</small>
          {stale && <small>작업의 현재 조립 버전과 다름</small>}
        </button>
        <div className="wardrobe-body-actions">
          {body.is_default ? <span className="wardrobe-body-default">기본 몸</span>
            : <button type="button" disabled={!!busy} onClick={() => void makeDefault(body)}>{busy === `default:${body.job_id}` ? '지정 중' : '기본 몸으로 지정'}</button>}
          <button type="button" disabled={!!busy} onClick={() => void unregister(body)}>{busy === `remove:${body.job_id}` ? '빼는 중' : '옷장에서 빼기'}</button>
        </div>
      </article>;
    })}</div>}
    {(error || wardrobe.error) && <p role="alert">{error || wardrobe.error}</p>}
  </section>;
}
