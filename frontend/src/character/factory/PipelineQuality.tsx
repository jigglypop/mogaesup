import type { NativePartsState } from './api';
import { partLabels } from './parts';

const number = (value: number) => value.toLocaleString('ko-KR');
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(2)} MB`;

export function PipelineQuality({ state }: { state: NativePartsState }) {
  const quality = state.quality;
  if (!quality) return null;
  const rear = quality.rear_coverage;
  const runtime = quality.runtime;
  const model = quality.delivery.model;
  const report = state.artifacts.find(item => item.name === 'quality.json');
  return <details className="assembly-quality">
    <summary>조립 검수 · {quality.visual_review === 'approved' ? '시각 승인 완료' : '시각 검수 필요'}</summary>
    <dl>
      <dt>후면 헤어 가림</dt><dd>{rear?.rays ? `${percent(rear.ratio)} · ${number(rear.covered)}/${number(rear.rays)} 지점` : '미측정'}</dd>
      {rear?.rays ? <><dt>후면 형상 가림</dt><dd>{percent(rear.geometric_ratio)}</dd></> : null}
      {runtime.triangles != null && <><dt>조립 삼각형</dt><dd>{number(runtime.triangles)}</dd></>}
      {runtime.texture_pixels != null && <><dt>텍스처 픽셀</dt><dd>{number(runtime.texture_pixels)}</dd></>}
      {model && <><dt>전송 파일</dt><dd>{bytes(model.source_bytes)} → {bytes(model.runtime_bytes)}</dd></>}
    </dl>
    {quality.checks.filter(check => check.code === 'part_budget' && check.status === 'exceeded').map(check =>
      <p key={`${check.code}:${check.slot}`}>{partLabels[check.slot || ''] || check.slot} 삼각형 {number(check.actual || 0)} / 기준 {number(check.target || 0)}</p>)}
    {Object.entries(quality.parts).filter(([, part]) => part.penetration).map(([slot, part]) =>
      <p key={slot}>{partLabels[slot] || slot} 몸 침투 {percent(part.penetration!.ratio)} · {number(part.penetration!.inside)}/{number(part.penetration!.vertices)} 정점</p>)}
    {report && <a href={report.url} download>검수 기록 JSON</a>}
  </details>;
}
