import { request, savedRequest } from '../api';
import type { FactoryJob } from '../factory/api';
import type { BodyType } from './base-bodies-api';

export type BodyGlbAsset = { id: string; bytes: number; rigged: boolean; bone_count: number; triangles: number; animations: string[] };
type GlbBodyInput = { name: string; body_type: BodyType; model_asset: string;
  import_mode: 'register' | 'rig'; generate_motions: boolean; prepare_expression_uv: boolean };
export type GlbBodyDraft = { name: string; asset?: BodyGlbAsset; filename?: string;
  import_mode: 'register' | 'rig'; generate_motions: boolean; prepare_expression_uv: boolean };
const draftKey = (type: BodyType) => `gaesup.base-body-glb-draft:${type}`;
const hash = /^[a-f0-9]{64}$/;

const glbBodies = (type: BodyType) => savedRequest<GlbBodyInput>(`gaesup.base-body-glb-pending:${type}`, ({ input }) =>
  input.body_type === type && typeof input.name === 'string' && hash.test(input.model_asset) && typeof input.prepare_expression_uv === 'boolean',
  '저장된 GLB 등록 요청을 읽을 수 없습니다. 브라우저 저장 공간을 확인하세요.');
export const glbRecovery = (type: BodyType) => glbBodies(type).read();

export function readGlbDraft(type: BodyType): GlbBodyDraft {
  const fallback: GlbBodyDraft = { name: type === 'male' ? '기본 남성형' : '기본 여성형',
    import_mode: 'register', generate_motions: true, prepare_expression_uv: false };
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey(type)) || 'null') as GlbBodyDraft | null;
    if (!saved || typeof saved.name !== 'string' || (saved.asset && !hash.test(saved.asset.id))) return fallback;
    return { ...saved, import_mode: saved.import_mode === 'rig' ? 'rig' : 'register',
      generate_motions: saved.generate_motions !== false, prepare_expression_uv: saved.prepare_expression_uv === true };
  } catch { return fallback; }
}

export const glbBodiesApi = {
  saveDraft: (type: BodyType, draft: GlbBodyDraft) => localStorage.setItem(draftKey(type), JSON.stringify(draft)),
  info: (id: string, signal?: AbortSignal) => request<BodyGlbAsset>(`/api/avatar-factory/base-bodies/glb-assets/${encodeURIComponent(id)}`, { signal }),
  upload: (file: File) => request<BodyGlbAsset>('/api/avatar-factory/base-bodies/glb-assets', {
    method: 'POST', headers: { 'Content-Type': 'model/gltf-binary' }, body: file, timeoutMs: 120000,
  }),
  create: (input: GlbBodyInput) => glbBodies(input.body_type).send(input, pending => request<FactoryJob>('/api/avatar-factory/base-bodies/glb', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
    body: JSON.stringify(pending.input), timeoutMs: 60000,
  })),
};
