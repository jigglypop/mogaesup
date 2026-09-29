import type { FactoryJob } from '../factory/api';

const stages: Record<string, string> = {
  queued: '생성 대기', reference: '기준 이미지 준비 중', images: '이미지 생성 중',
  models: '3D 생성 중', rig: '리깅 중', assemble: '조립 중', expressions: '표정 처리 중',
};
const failedModels = ['FAILED', 'CANCELED', 'failed', 'submission_rejected'];
const failedImages = ['failed', 'rejected', 'not_sent'];

export function AssetProductionStatus({ job, slot, hasModel, hasAssembly, compact = false }: {
  job: FactoryJob; slot?: string; hasModel: boolean; hasAssembly: boolean; compact?: boolean;
}) {
  const part = slot ? job.parts?.find(item => item.slot === slot) : undefined;
  const parts = slot ? (part ? [part] : []) : job.parts || [];
  const images = parts.flatMap(item => Object.values(item.views || {}).length
    ? Object.values(item.views!) : [{ status: item.image_status }]);
  const imagesReady = images.filter(image => image.status === 'succeeded').length;
  const modelsReady = parts.filter(item => job.artifacts.some(asset => asset.name === `generated-${item.slot}.glb`)
    || job.assembly_artifacts?.some(asset => asset.name === `${item.slot}.glb`)).length;
  const flow = job.character_flow;
  const blocked = !!job.error || ['blocked', 'paused'].includes(flow?.status || '')
    || ['failed', 'pipeline_paused', 'recovery_required'].includes(job.status);
  const uncertain = parts.some(item => item.model_status === 'submission_uncertain'
    || Object.values(item.views || {}).some(image => image.status === 'submission_uncertain'));
  const failed = parts.some(item => failedModels.includes(item.model_status)
    || failedImages.includes(item.image_status)
    || Object.values(item.views || {}).some(image => failedImages.includes(image.status)));
  const assembled = hasAssembly && (slot ? part?.assembly_status !== 'failed'
    : flow?.stage === 'complete' || job.production_progress?.steps.some(step => step.id === 'assemble' && step.state === 'complete'));
  let label = '생성 대기', tone = 'pending';
  if (slot && assembled) { label = '조립 완료'; tone = 'ready'; }
  else if (!slot && assembled && flow?.stage === 'complete') { label = '조립 완료'; tone = 'ready'; }
  else if (slot && hasModel) { label = '3D 저장됨'; tone = 'ready'; }
  else if (uncertain) { label = '응답 확인 필요'; tone = 'blocked'; }
  else if (failed || blocked) { label = '생성 중단'; tone = 'blocked'; }
  else if (part?.model_status === 'SUCCEEDED') { label = '3D 내려받는 중'; tone = 'running'; }
  else if (part && ['PENDING', 'IN_PROGRESS'].includes(part.model_status) && flow?.busy) {
    label = part.model_status === 'PENDING' ? '3D 접수됨' : `3D 생성 중 · ${Math.min(99, Math.max(0, part.progress || 0))}%`;
    tone = 'running';
  } else if (flow?.busy) { label = stages[flow.stage] || '생성 중'; tone = 'running'; }
  else if (assembled) { label = '조립 완료'; tone = 'ready'; }
  else if (hasModel) { label = '3D 저장됨'; tone = 'ready'; }
  else if (imagesReady) { label = '이미지 준비됨 · 3D 대기'; }
  const assembly = part?.assembly_status === 'failed' ? '중단'
    : assembled ? '완료' : flow?.busy && flow.stage === 'assemble' ? '진행 중' : '대기';
  const detail = blocked ? job.error || flow?.message : undefined;
  return <div className="asset-production-status" aria-label={slot ? '파츠 생성 상태' : '캐릭터 생성 상태'}>
    <strong className={`asset-state-badge ${tone}`}>{label}</strong>
    {!compact && <div className="asset-stage-counts"><span>이미지 {imagesReady}/{images.length}</span><span>3D {slot && hasModel ? 1 : modelsReady}/{parts.length || (slot ? 1 : 0)}</span><span>조립 {assembly}</span></div>}
    {!compact && detail && <p className="asset-state-detail">{detail}</p>}
  </div>;
}
