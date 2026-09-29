import { isDefinitiveRejection, request } from '../api';

export type GenerationKind = 'prop' | 'texture' | 'illustration';
export type GenerationSize = 256 | 512 | 1024;
export type GenerationStatus = 'accepted' | 'running' | 'paused' | 'blocked' | 'complete';
export type GenerationStage = 'image' | 'model' | 'material' | 'complete';

export type GenerationArtifact = { name: string; url: string; sha256: string };
export type Generation = {
  id: string;
  request_key: string;
  kind: GenerationKind;
  category: string;
  name: string;
  prompt: string;
  size: GenerationSize;
  status: GenerationStatus;
  stage: GenerationStage;
  error?: string;
  can_resume: boolean;
  created_at: string;
  progress?: number;
  task_id?: string;
  artifacts: GenerationArtifact[];
  gpu?: { estimated_bytes_with_mips: number };
  reference_id?: string | null;
  vector?: GenerationVector | null;
  rig?: GenerationRig | null;
  motions?: Partial<Record<MotionTemplate, GenerationMotion>> | null;
};
export type Joint = [number, number];
export type GenerationRig = {
  sha256: string; revision: string; skeleton: string; joints: Record<string, Joint>; proposed: Record<string, Joint>;
  adjusted: boolean; width: number; height: number; vertices: number; triangles: number; source_sha256: string; created_at: string;
};
export type MotionTemplate = 'idle' | 'wave' | 'jump' | 'nod' | 'shake' | 'sway';
export type MotionFormat = 'gif' | 'webp' | 'apng';
export type MotionInput = { template: MotionTemplate; strength: number; speed: number; fps: 12 | 15 | 24; size: 240 | 360 | 480 };
export type GenerationMotion = MotionInput & {
  rig_sha256: string; revision: string; frames: number; duration_ms: number;
  files: Record<MotionFormat, string>; bytes: Record<MotionFormat, number>; created_at: string;
};
export type VectorColors = 12 | 16 | 24 | 32;
export type GenerationVector = {
  colors: VectorColors; paths: number; palette: string[]; width: number; height: number; bytes: number;
  revision: string; source_sha256: string; created_at: string;
};

export type GenerationInput = {
  kind: GenerationKind;
  category: string;
  name: string;
  prompt: string;
  size: GenerationSize;
  reference_id?: string;
};

export type GenerationList = {
  items: Generation[];
  capabilities: { ready: boolean; reason?: string };
  defaults: Record<string, string>;
};

type PendingGeneration = { key: string; input: GenerationInput };

const pendingStorageKey = (kind: GenerationKind) => `gaesup.studio.generation.${kind}.v1`;
const isSize = (value: unknown): value is GenerationSize => value === 256 || value === 512 || value === 1024;

export function generationRecovery(kind: GenerationKind): { pending: PendingGeneration | null; error: string } {
  try {
    const raw = localStorage.getItem(pendingStorageKey(kind));
    if (!raw) return { pending: null, error: '' };
    const pending = JSON.parse(raw) as PendingGeneration;
    const input = pending?.input;
    if (!pending || typeof pending.key !== 'string' || !pending.key || !input || input.kind !== kind
      || typeof input.category !== 'string' || !input.category
      || typeof input.name !== 'string' || typeof input.prompt !== 'string' || !isSize(input.size)
      || (input.reference_id !== undefined && !/^[a-f0-9]{24}$/.test(input.reference_id))) throw new Error();
    return { pending, error: '' };
  } catch {
    return { pending: null, error: '저장된 생성 요청을 읽을 수 없습니다. 브라우저 저장소의 요청 기록을 확인해 주세요.' };
  }
}

function clearPending(kind: GenerationKind, requestKey: string) {
  const recovery = generationRecovery(kind);
  if (recovery.pending?.key === requestKey) localStorage.removeItem(pendingStorageKey(kind));
}

export const generationsApi = {
  async list(kind: GenerationKind, signal?: AbortSignal) {
    const result = await request<GenerationList>(`/api/studio/generations?${new URLSearchParams({ kind })}`, { signal });
    const pending = generationRecovery(kind).pending;
    if (pending && result.items.some(item => item.request_key === pending.key)) clearPending(kind, pending.key);
    return result;
  },
  illustrationSelection: (signal?: AbortSignal) => request<{selected:string|null;revision:string}>('/api/studio/illustration-selection', {signal}),
  selectIllustration: (generation_id: string | null, revision: string) => request<{selected:string|null;revision:string}>('/api/studio/illustration-selection', {
    method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({generation_id,revision}),
  }),
  get: (id: string, signal?: AbortSignal) => request<Generation>(`/api/studio/generations/${encodeURIComponent(id)}`, { signal }),
  recovery: generationRecovery,
  async create(input: GenerationInput) {
    const recovery = generationRecovery(input.kind);
    if (recovery.error) throw new Error(recovery.error);
    const pending = recovery.pending || { key: crypto.randomUUID(), input };
    localStorage.setItem(pendingStorageKey(input.kind), JSON.stringify(pending));
    try {
      const result = await request<Generation>('/api/studio/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
        body: JSON.stringify(pending.input),
        timeoutMs: 60000,
      });
      if (result.request_key === pending.key) clearPending(input.kind, pending.key);
      return result;
    } catch (error) {
      if (isDefinitiveRejection(error)) clearPending(input.kind, pending.key);
      throw error;
    }
  },
  resume: (id: string) => request<Generation>(`/api/studio/generations/${encodeURIComponent(id)}/resume`, { method: 'POST', timeoutMs: 60000 }),
  vectorize: (id: string, colors: VectorColors) => request<Generation>(`/api/studio/generations/${encodeURIComponent(id)}/vector`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ colors }), timeoutMs: 60000,
  }),
  rig: (id: string, joints?: Record<string, Joint>, revision?: string) => request<Generation>(`/api/studio/generations/${encodeURIComponent(id)}/rig`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(joints ? { joints } : {}), ...(revision ? { revision } : {}) }), timeoutMs: 60000,
  }),
  motion: (id: string, input: MotionInput) => request<Generation>(`/api/studio/generations/${encodeURIComponent(id)}/motions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), timeoutMs: 60000,
  }),
};
