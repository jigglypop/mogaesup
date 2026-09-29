import { isDefinitiveRejection, request } from '../api';
import type { FactoryJob } from '../factory/api';
import type { BodyGlbAsset } from './glb-bodies-api';

export const glbAssetSlots = ['body', 'hair', 'hat', 'top', 'bottom', 'shoes', 'weapon', 'tool', 'glasses', 'prop'] as const;
export type GlbAssetSlot = typeof glbAssetSlots[number];
export type GlbAssetInput = { name: string; slot: GlbAssetSlot; model_asset: string };
export type GlbAssetPreparation = { action: 'fit' | 'rig'; base_job_id?: string; base_version?: string; body_type?: 'male' | 'female' };
export type GlbAssetRecord = GlbAssetInput & {
  id: string; created_at: string; source: { url: string; sha256: string }; info: BodyGlbAsset;
  operations?: { id: string; action: string; job_id: string; status: string; error?: string | null }[];
};
type Pending<T> = { key: string; input: T };
const root = '/api/studio/glb-assets';
const registerKey = 'gaesup.glb-assets.register.v1';
const prepareKey = (id: string) => `gaesup.glb-assets.prepare.v1:${id}`;
const hash = /^[a-f0-9]{64}$/;
const jobId = /^[a-f0-9]{24}$/;

function recovery<T>(key: string, valid: (input: T) => boolean): { pending: Pending<T> | null; error: string } {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { pending: null, error: '' };
    const value = JSON.parse(raw) as Pending<T>;
    if (!value || typeof value.key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value.key) || !value.input || !valid(value.input)) throw new Error();
    return { pending: value, error: '' };
  } catch { return { pending: null, error: '저장된 GLB 요청을 읽을 수 없습니다. 브라우저 저장 공간을 확인하세요.' }; }
}
export const glbAssetRecovery = () => recovery<GlbAssetInput>(registerKey,
  input => typeof input.name === 'string' && glbAssetSlots.includes(input.slot) && hash.test(input.model_asset));
export const glbPreparationRecovery = (id: string) => recovery<GlbAssetPreparation>(prepareKey(id), input =>
  input.action === 'fit' ? jobId.test(input.base_job_id || '') && jobId.test(input.base_version || '')
    : input.action === 'rig' && (input.body_type === 'male' || input.body_type === 'female'));

async function submit<T, R>(url: string, storage: string, pending: Pending<T> | null, input: T): Promise<R> {
  const saved = pending || { key: crypto.randomUUID(), input };
  localStorage.setItem(storage, JSON.stringify(saved));
  try {
    const result = await request<R>(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': saved.key },
      body: JSON.stringify(saved.input), timeoutMs: 60000 });
    if (JSON.parse(localStorage.getItem(storage) || 'null')?.key === saved.key) localStorage.removeItem(storage);
    return result;
  } catch (error) {
    if (isDefinitiveRejection(error)) localStorage.removeItem(storage);
    throw error;
  }
}

export const glbAssetsApi = {
  list: (signal?: AbortSignal) => request<{ items: GlbAssetRecord[] }>(root, { signal, timeoutMs: 25000 }),
  upload: (file: File) => request<BodyGlbAsset>(`${root}/upload`, { method: 'POST', headers: { 'Content-Type': 'model/gltf-binary' }, body: file, timeoutMs: 120000 }),
  async create(input: GlbAssetInput) {
    const { pending, error } = glbAssetRecovery();
    if (error) throw new Error(error);
    return submit<GlbAssetInput, GlbAssetRecord>(root, registerKey, pending, input);
  },
  async prepare(id: string, input: GlbAssetPreparation) {
    const { pending, error } = glbPreparationRecovery(id);
    if (error) throw new Error(error);
    return submit<GlbAssetPreparation, FactoryJob>(`${root}/${encodeURIComponent(id)}/prepare`, prepareKey(id), pending, input);
  },
};
