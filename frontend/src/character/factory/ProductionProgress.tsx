import type { FactoryJob } from './api';

const states: Record<string, string> = { running: '진행 중', complete: '완료', blocked: '중단', paused: '중단', pending: '대기', review_required: '완료' };

export function ProductionProgress({ job, offline }: { job: FactoryJob; offline: boolean }) {
  const progress = job.production_progress;
  if (!progress) return <section className="production-progress" aria-label="제작 진행"><span>{offline ? '연결 끊김' : '작업 상태'}</span><p>{job.progress.message}</p></section>;
  const current = progress.steps.find(step => step.id === progress.current);
  return <section className="production-progress" aria-label="제작 진행" data-status={offline ? 'offline' : progress.status}>
    <div className="production-progress-heading"><div><span className="production-status-dot" /><strong>{offline ? '재연결 중' : progress.status === 'review_required' ? '조립 완료' : `${current?.label || '제작'} · ${states[progress.status] || progress.status}`}</strong></div><b>{progress.percent}<small>%</small></b></div>
    <div className="production-track" role="progressbar" aria-label="전체 제작 진행률" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100} aria-valuetext={`${progress.percent}% · ${current?.label || '제작'} · ${states[progress.status] || progress.status}`}><i style={{ width: `${progress.percent}%` }} /></div>
    <ol className="production-stages">{progress.steps.map((step, index) => <li key={step.id} data-state={step.state} aria-current={step.id === progress.current ? 'step' : undefined}>
      <span className="production-step-number">{step.state === 'complete' ? '✓' : String(index + 1).padStart(2, '0')}</span>
      <strong>{step.label}</strong><span>{states[step.state] || step.state}{step.total > 1 && ` · ${step.completed}/${step.total}`}</span>
      <div className="production-step-track"><i style={{ width: `${step.percent || 0}%` }} /></div>
    </li>)}</ol>
    <div className="production-progress-footer"><span role="status">{progress.message}</span>{progress.images_total != null && <span>이미지 수신 {progress.images_received}/{progress.images_total}</span>}</div>
  </section>;
}
