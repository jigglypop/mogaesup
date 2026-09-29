import { request, savedRequest } from '../api';
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

type ExpressionReference = {
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
type ExpressionGenerationInput = { name: ExpressionGenerationName; prompt: string; reference_assets?: string[] };
type ExpressionBatchInput = { reference_assets: string[] };
type ExpressionGenerationList = {
  items: ExpressionGeneration[];
  capabilities: { ready: boolean; reason: string | null };
  defaults: Record<ExpressionGenerationName, string>;
  reference: ExpressionReference;
  batches: ExpressionBatch[];
};

const expressionGenerations = (job: string, version: string) => savedRequest<ExpressionGenerationInput>(
  `gaesup.studio.expression-generation.${job}.${version}.v1`, ({ input }) =>
    typeof input.name === 'string' && input.name in expressionNames && typeof input.prompt === 'string' && !!input.prompt.trim()
      && (input.reference_assets === undefined || (Array.isArray(input.reference_assets)
        && input.reference_assets.every(id => typeof id === 'string' && !!id))),
  '저장된 표정 생성 요청을 읽을 수 없습니다. 브라우저 저장소의 요청 기록을 확인해 주세요.');
const expressionBatches = (job: string, version: string) => savedRequest<ExpressionBatchInput>(
  `gaesup.studio.expression-generation-batch.${job}.${version}.v1`, ({ input }) =>
    Array.isArray(input.reference_assets) && input.reference_assets.length >= 1 && input.reference_assets.length <= 3
      && input.reference_assets.every(id => typeof id === 'string' && !!id),
  '저장된 기본 5종 생성 요청을 읽을 수 없습니다. 브라우저 저장소의 요청 기록을 확인해 주세요.');
const answered = (result: { request_key: string }, key: string) => result.request_key === key;

const endpoint = (job: string, version: string) => `/api/studio/bodies/${encodeURIComponent(job)}/${encodeURIComponent(version)}/expression-generations`;
const referenceEndpoint = (job: string, version: string) => `/api/studio/bodies/${encodeURIComponent(job)}/${encodeURIComponent(version)}/expression-reference`;

export const expressionGenerationApi = {
  async list(job: string, version: string, signal?: AbortSignal) {
    const result = await request<ExpressionGenerationList>(endpoint(job, version), { signal });
    const pending = expressionGenerations(job, version).read().pending;
    if (pending && result.items.some(item => item.request_key === pending.key)) expressionGenerations(job, version).settle(pending.key);
    const batchPending = expressionBatches(job, version).read().pending;
    if (batchPending && result.batches?.some(item => item.request_key === batchPending.key)) expressionBatches(job, version).settle(batchPending.key);
    return result;
  },
  recovery: (job: string, version: string) => expressionGenerations(job, version).read(),
  batchRecovery: (job: string, version: string) => expressionBatches(job, version).read(),
  uploadReference: (file: File) => request<{ id: string; width: number; height: number; alpha: boolean }>('/api/avatar-blueprints/assets', {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: file, timeoutMs: 60000,
  }),
  saveReference: (job: string, version: string, assets: string[], revision: string) => request<ExpressionReference>(referenceEndpoint(job, version), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assets, revision }),
  }),
  create: (job: string, version: string, input: ExpressionGenerationInput) => expressionGenerations(job, version).send(input, pending =>
    request<ExpressionGeneration>(endpoint(job, version), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
      body: JSON.stringify(pending.input),
      timeoutMs: 60000,
    }), { answered }),
  resume: (job: string, version: string, id: string) => request<ExpressionGeneration>(
    `${endpoint(job, version)}/${encodeURIComponent(id)}/resume`, { method: 'POST', timeoutMs: 60000 },
  ),
  createBatch: (job: string, version: string, input: ExpressionBatchInput) => expressionBatches(job, version).send(input, pending =>
    request<ExpressionBatch>(`${endpoint(job, version)}/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
      body: JSON.stringify(pending.input), timeoutMs: 60000,
    }), { answered }),
  resumeBatch: (job: string, version: string, id: string) => request<ExpressionBatch>(
    `${endpoint(job, version)}/batch/${encodeURIComponent(id)}/resume`, { method: 'POST', timeoutMs: 60000 },
  ),
};
