import { isDefinitiveRejection, request } from '../api';
import { expressionNames, type ExpressionName } from '../texture-expressions';

export type ExpressionGenerationName = ExpressionName;
export type ExpressionGenerationStatus = 'accepted' | 'running' | 'paused' | 'blocked' | 'complete';
export type ExpressionGenerationStage = 'image' | 'complete';
export type ExpressionGenerationArtifact = { name: string; url: string; sha256: string };

export type ExpressionGeneration = {
  id: string;
  request_key: string;
  job_id: string;
  body_version: string;
  body_sha256: string;
  name: ExpressionGenerationName;
  prompt: string;
  source: { kind: string; sha256: string };
  status: ExpressionGenerationStatus;
  stage: ExpressionGenerationStage;
  error: string | null;
  can_resume: boolean;
  created_at: string;
  artifacts: ExpressionGenerationArtifact[];
};

export type ExpressionReference = {
  revision: string;
  assets: { id: string; url: string }[];
  updated_at?: string;
};
export type ExpressionBatch = {
  id: string;
  request_key: string;
  status: ExpressionGenerationStatus;
  created_at: string;
  error: string | null;
  can_resume: boolean;
  items: { name: ExpressionGenerationName; generation_id: string | null; status: string; error: string | null }[];
};
export type ExpressionGenerationInput = { name: ExpressionGenerationName; prompt: string; reference_assets?: string[] };
export type ExpressionBatchInput = { reference_assets: string[] };
export type ExpressionGenerationList = {
  items: ExpressionGeneration[];
  capabilities: { ready: boolean; reason: string | null };
  defaults: Record<ExpressionGenerationName, string>;
  reference: ExpressionReference;
  batches: ExpressionBatch[];
};

type PendingExpressionGeneration = { key: string; input: ExpressionGenerationInput };
type PendingExpressionBatch = { key: string; input: ExpressionBatchInput };

const storageKey = (job: string, version: string) => `gaesup.studio.expression-generation.${job}.${version}.v1`;
const batchStorageKey = (job: string, version: string) => `gaesup.studio.expression-generation-batch.${job}.${version}.v1`;

export function expressionGenerationRecovery(job: string, version: string): {
  pending: PendingExpressionGeneration | null; error: string;
} {
  try {
    const raw = localStorage.getItem(storageKey(job, version));
    if (!raw) return { pending: null, error: '' };
    const pending = JSON.parse(raw) as PendingExpressionGeneration;
    if (!pending || typeof pending.key !== 'string' || !pending.key
      || !pending.input || typeof pending.input.name !== 'string' || !(pending.input.name in expressionNames)
      || typeof pending.input.prompt !== 'string' || !pending.input.prompt.trim()
      || pending.input.reference_assets !== undefined && (!Array.isArray(pending.input.reference_assets)
        || pending.input.reference_assets.some(id => typeof id !== 'string' || !id))) throw new Error();
    return { pending, error: '' };
  } catch {
    return { pending: null, error: '저장된 표정 생성 요청을 읽을 수 없습니다. 브라우저 저장소의 요청 기록을 확인해 주세요.' };
  }
}

export function expressionBatchRecovery(job: string, version: string): {
  pending: PendingExpressionBatch | null; error: string;
} {
  try {
    const raw = localStorage.getItem(batchStorageKey(job, version));
    if (!raw) return { pending: null, error: '' };
    const pending = JSON.parse(raw) as PendingExpressionBatch;
    if (!pending || typeof pending.key !== 'string' || !pending.key || !pending.input
      || !Array.isArray(pending.input.reference_assets) || pending.input.reference_assets.length < 1
      || pending.input.reference_assets.length > 3
      || pending.input.reference_assets.some(id => typeof id !== 'string' || !id)) throw new Error();
    return { pending, error: '' };
  } catch {
    return { pending: null, error: '저장된 기본 5종 생성 요청을 읽을 수 없습니다. 브라우저 저장소의 요청 기록을 확인해 주세요.' };
  }
}

function clearPending(job: string, version: string, requestKey: string) {
  const recovery = expressionGenerationRecovery(job, version);
  if (recovery.pending?.key === requestKey) localStorage.removeItem(storageKey(job, version));
}
function clearBatchPending(job: string, version: string, requestKey: string) {
  const recovery = expressionBatchRecovery(job, version);
  if (recovery.pending?.key === requestKey) localStorage.removeItem(batchStorageKey(job, version));
}

const endpoint = (job: string, version: string) => `/api/studio/bodies/${encodeURIComponent(job)}/${encodeURIComponent(version)}/expression-generations`;
const referenceEndpoint = (job: string, version: string) => `/api/studio/bodies/${encodeURIComponent(job)}/${encodeURIComponent(version)}/expression-reference`;

export const expressionGenerationApi = {
  async list(job: string, version: string, signal?: AbortSignal) {
    const result = await request<ExpressionGenerationList>(endpoint(job, version), { signal });
    const pending = expressionGenerationRecovery(job, version).pending;
    if (pending && result.items.some(item => item.request_key === pending.key)) clearPending(job, version, pending.key);
    const batchPending = expressionBatchRecovery(job, version).pending;
    if (batchPending && result.batches?.some(item => item.request_key === batchPending.key)) clearBatchPending(job, version, batchPending.key);
    return result;
  },
  get: (job: string, version: string, id: string, signal?: AbortSignal) =>
    request<ExpressionGeneration>(`${endpoint(job, version)}/${encodeURIComponent(id)}`, { signal }),
  recovery: expressionGenerationRecovery,
  batchRecovery: expressionBatchRecovery,
  uploadReference: (file: File) => request<{ id: string; width: number; height: number; alpha: boolean }>('/api/avatar-blueprints/assets', {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: file, timeoutMs: 60000,
  }),
  saveReference: (job: string, version: string, assets: string[], revision: string) => request<ExpressionReference>(referenceEndpoint(job, version), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assets, revision }),
  }),
  async create(job: string, version: string, input: ExpressionGenerationInput) {
    const recovery = expressionGenerationRecovery(job, version);
    if (recovery.error) throw new Error(recovery.error);
    const pending = recovery.pending || { key: crypto.randomUUID(), input };
    localStorage.setItem(storageKey(job, version), JSON.stringify(pending));
    try {
      const result = await request<ExpressionGeneration>(endpoint(job, version), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
        body: JSON.stringify(pending.input),
        timeoutMs: 60000,
      });
      if (result.request_key === pending.key) clearPending(job, version, pending.key);
      return result;
    } catch (error) {
      if (isDefinitiveRejection(error)) clearPending(job, version, pending.key);
      throw error;
    }
  },
  resume: (job: string, version: string, id: string) => request<ExpressionGeneration>(
    `${endpoint(job, version)}/${encodeURIComponent(id)}/resume`, { method: 'POST', timeoutMs: 60000 },
  ),
  async createBatch(job: string, version: string, input: ExpressionBatchInput) {
    const recovery = expressionBatchRecovery(job, version);
    if (recovery.error) throw new Error(recovery.error);
    const pending = recovery.pending || { key: crypto.randomUUID(), input };
    localStorage.setItem(batchStorageKey(job, version), JSON.stringify(pending));
    try {
      const result = await request<ExpressionBatch>(`${endpoint(job, version)}/batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
        body: JSON.stringify(pending.input), timeoutMs: 60000,
      });
      if (result.request_key === pending.key) clearBatchPending(job, version, pending.key);
      return result;
    } catch (error) {
      if (isDefinitiveRejection(error)) clearBatchPending(job, version, pending.key);
      throw error;
    }
  },
  resumeBatch: (job: string, version: string, id: string) => request<ExpressionBatch>(
    `${endpoint(job, version)}/batch/${encodeURIComponent(id)}/resume`, { method: 'POST', timeoutMs: 60000 },
  ),
};
