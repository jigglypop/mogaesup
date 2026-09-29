import { isDefinitiveRejection, request } from '../api';
import type { FactoryJob } from '../factory/api';
import type { BodyType } from './base-bodies-api';

export type BodyGlbAsset = { id: string; bytes: number; rigged: boolean; bone_count: number; triangles: number; animations: string[] };
export type GlbBodyInput = { name: string; body_type: BodyType; model_asset: string;
  import_mode: 'register' | 'rig'; generate_motions: boolean; prepare_expression_uv: boolean };
export type GlbBodyDraft = { name: string; asset?: BodyGlbAsset; filename?: string;
  import_mode: 'register' | 'rig'; generate_motions: boolean; prepare_expression_uv: boolean };
type Pending = { key: string; input: GlbBodyInput };
const draftKey = (type: BodyType) => `gaesup.base-body-glb-draft:${type}`;
const pendingKey = (type: BodyType) => `gaesup.base-body-glb-pending:${type}`;
const hash = /^[a-f0-9]{64}$/;

export function glbRecovery(type: BodyType): { pending: Pending | null; error: string } {
  try {
    const raw = localStorage.getItem(pendingKey(type));
    if (!raw) return { pending: null, error: '' };
    const value = JSON.parse(raw) as Pending;
    if (!value.key || value.input?.body_type !== type || typeof value.input.name !== 'string'
      || !hash.test(value.input.model_asset) || typeof value.input.prepare_expression_uv !== 'boolean') throw new Error();
    return { pending: value, error: '' };
  } catch { return { pending: null, error: '저장된 GLB 등록 요청을 읽을 수 없습니다. 브라우저 저장 공간을 확인하세요.' }; }
}

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
  async create(input: GlbBodyInput) {
    const recovery = glbRecovery(input.body_type);
    if (recovery.error) throw new Error(recovery.error);
    const pending = recovery.pending || { key: crypto.randomUUID(), input };
    localStorage.setItem(pendingKey(input.body_type), JSON.stringify(pending));
    try {
      const result = await request<FactoryJob>('/api/avatar-factory/base-bodies/glb', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
        body: JSON.stringify(pending.input), timeoutMs: 60000,
      });
      if (glbRecovery(input.body_type).pending?.key === pending.key) localStorage.removeItem(pendingKey(input.body_type));
      return result;
    } catch (error) {
      if (isDefinitiveRejection(error)) localStorage.removeItem(pendingKey(input.body_type));
      throw error;
    }
  },
};
