import { request, savedRequest, type Pending } from '../api';
import type { FactoryJob } from '../factory/api';
import { variantSlots } from '../factory/parts';
import type { BodyGlbAsset } from './glb-bodies-api';

export const glbAssetSlots = ['body', ...variantSlots, 'prop'] as const;
export type GlbAssetSlot = typeof glbAssetSlots[number];
export type GlbAssetInput = { name: string; slot: GlbAssetSlot; model_asset: string };
type GlbAssetPreparation = { action: 'fit' | 'rig'; base_job_id?: string; base_version?: string; body_type?: 'male' | 'female' };
export type GlbAssetRecord = GlbAssetInput & {
  id: string; created_at: string; source: { url: string; sha256: string }; info: BodyGlbAsset;
  operations?: { id: string; action: string; job_id: string; status: string; error?: string | null }[];
};
const root = '/api/studio/glb-assets';
const hash = /^[a-f0-9]{64}$/;
const jobId = /^[a-f0-9]{24}$/;

const saved = <T>(storage: string, valid: (input: T) => boolean) => savedRequest<T>(storage,
  (pending: Pending<T>) => /^[a-zA-Z0-9_-]{8,100}$/.test(pending.key) && valid(pending.input),
  '저장된 GLB 요청을 읽을 수 없습니다. 브라우저 저장 공간을 확인하세요.');
const registration = saved<GlbAssetInput>('gaesup.glb-assets.register.v1',
  input => typeof input.name === 'string' && glbAssetSlots.includes(input.slot) && hash.test(input.model_asset));
const preparation = (id: string) => saved<GlbAssetPreparation>(`gaesup.glb-assets.prepare.v1:${id}`, input =>
  input.action === 'fit' ? jobId.test(input.base_job_id || '') && jobId.test(input.base_version || '')
    : input.action === 'rig' && (input.body_type === 'male' || input.body_type === 'female'));
export const glbAssetRecovery = () => registration.read();
export const glbPreparationRecovery = (id: string) => preparation(id).read();

const post = <R>(url: string) => (pending: Pending<unknown>) => request<R>(url, { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key }, body: JSON.stringify(pending.input), timeoutMs: 60000 });

export const glbAssetsApi = {
  list: (signal?: AbortSignal) => request<{ items: GlbAssetRecord[] }>(root, { signal, timeoutMs: 25000 }),
  upload: (file: File) => request<BodyGlbAsset>(`${root}/upload`, { method: 'POST', headers: { 'Content-Type': 'model/gltf-binary' }, body: file, timeoutMs: 120000 }),
  create: (input: GlbAssetInput) => registration.send(input, post<GlbAssetRecord>(root)),
  prepare: (id: string, input: GlbAssetPreparation) => preparation(id).send(input, post<FactoryJob>(`${root}/${encodeURIComponent(id)}/prepare`)),
};
