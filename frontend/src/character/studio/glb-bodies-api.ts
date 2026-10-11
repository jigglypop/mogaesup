import { ApiError, request, savedRequest } from '../api';
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

// A GLB of up to 256 MB goes up whole, so its deadline grows with the file: the time to send it at 2 Mbps and a minute
// for the server's check, at least two minutes. It ends at most half a minute after the app server gives up: that
// server waits ten minutes from the request's arrival for the character server's answer, the upload included
// (READ_TIMEOUT in server/src/factory.rs), then answers `factory_timeout`. So a large GLB needs a line faster than
// 2 Mbps; 256 MB, more than 3.6 Mbps.
export const glbUploadTimeout = (bytes: number) => Math.min(630_000, Math.max(120_000, Math.ceil(bytes / 250) + 60_000));
/** Sends a GLB file to `url`; running out of time, in the browser or on the app server (`factory_timeout`), is reported
 * as the upload's, not as a slow server. */
export async function uploadGlb(url: string, file: File) {
  try {
    return await request<BodyGlbAsset>(url, {
      method: 'POST', headers: { 'Content-Type': 'model/gltf-binary' }, body: file, timeoutMs: glbUploadTimeout(file.size),
    });
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'timeout' || error.code === 'factory_timeout')) {
      throw new ApiError(error.code, 'GLB 업로드가 제한 시간 안에 끝나지 않았습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.', error.status);
    }
    throw error;
  }
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
  upload: (file: File) => uploadGlb('/api/avatar-factory/base-bodies/glb-assets', file),
  create: (input: GlbBodyInput) => glbBodies(input.body_type).send(input, pending => request<FactoryJob>('/api/avatar-factory/base-bodies/glb', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
    body: JSON.stringify(pending.input), timeoutMs: 60000,
  })),
};
