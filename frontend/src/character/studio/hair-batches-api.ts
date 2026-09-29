import { isDefinitiveRejection, request } from '../api';
import type { MeshyOptions } from './meshy-options';

export type HairView = 'front' | 'side' | 'back';
export type HairRedraw = { notes: string; source_side_facing: 'left' | 'right'; worn?: boolean };
export type HairSheetItem = {
  name: string;
  views: Record<HairView, string>;
  row: number;
  column: number;
};
export type HairBatchInput = {
  base_job_id: string;
  base_version: string;
  items: Pick<HairSheetItem, 'name' | 'views'>[];
  concurrency: number;
  meshy_options: MeshyOptions;
  redraw?: HairRedraw;
};
export type HairBatchItem = {
  index: number;
  name: string;
  status: string;
  job_id: string;
  error?: string | null;
  state_error?: string | null;
  progress?: { stage?: string; message?: string };
  task_id?: string | null;
  version?: string | null;
  prepared_views?: { view: HairView | 'opposite'; status: string; url: string | null;
    background_removal?: { alpha_min?: number } | null }[];
};
export type HairBatch = {
  id: string;
  status: string;
  error?: string | null;
  can_resume?: boolean;
  completed: number;
  created_at: string;
  updated_at?: string;
  input: HairBatchInput;
  items: HairBatchItem[];
};
export type PendingHairBatch = { key: string; input: HairBatchInput };

const endpoint = '/api/avatar-factory/part-batches';
const pendingKey = 'gaesup.hair-batch.pending.v1';
const assetPattern = /^[a-f0-9]{64}$/;

function validPending(value: unknown): value is PendingHairBatch {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Partial<PendingHairBatch>;
  const input = pending.input as Partial<HairBatchInput> | undefined;
  return typeof pending.key === 'string' && pending.key.length >= 8 && !!input
    && typeof input.base_job_id === 'string' && typeof input.base_version === 'string'
    && Number.isInteger(input.concurrency) && Number(input.concurrency) >= 1 && Number(input.concurrency) <= 4
    && !!input.meshy_options && typeof input.meshy_options === 'object'
    && (!input.redraw || (typeof input.redraw.notes === 'string' && input.redraw.notes.length <= 2000
      && ['left', 'right'].includes(input.redraw.source_side_facing)
      && (input.redraw.worn === undefined || typeof input.redraw.worn === 'boolean')))
    && Array.isArray(input.items) && input.items.length > 0 && input.items.length <= 48
    && input.items.every(item => typeof item?.name === 'string' && !!item.name.trim()
      && !!item.views && (['front', 'side', 'back'] as const).every(view => assetPattern.test(item.views[view])));
}

function recovery(): { pending: PendingHairBatch | null; error: string } {
  try {
    const raw = localStorage.getItem(pendingKey);
    if (!raw) return { pending: null, error: '' };
    const pending: unknown = JSON.parse(raw);
    if (!validPending(pending)) throw new Error();
    return { pending, error: '' };
  } catch {
    return { pending: null, error: '저장된 헤어 배치 요청을 읽을 수 없습니다. 요청 기록을 확인해야 새 배치를 접수할 수 있습니다.' };
  }
}

function clearPending(key: string) {
  if (recovery().pending?.key === key) localStorage.removeItem(pendingKey);
}

export const hairBatchesApi = {
  recovery,
  uploadSheet: (file: File) => request<{ id: string }>('/api/avatar-factory/meshy-options/texture-assets', {
    method: 'POST', body: file, timeoutMs: 60000,
  }),
  splitSheet: (input: { asset_id: string; rows: number; columns: number; row_edges?: number[]; view_edges?: number[][]; view_order: HairView[]; remove_skin: boolean; detect_view_seams?: boolean }) =>
    request<{ id: string; items: HairSheetItem[] }>(`${endpoint}/split-sheet`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), timeoutMs: 60000,
    }),
  list: (signal: AbortSignal) => request<{ items: HairBatch[] }>(endpoint, { signal, timeoutMs: 30000 }),
  get: (id: string, signal?: AbortSignal) => request<HairBatch>(`${endpoint}/${encodeURIComponent(id)}`, { signal, timeoutMs: 30000 }),
  resume: (id: string) => request<HairBatch>(`${endpoint}/${encodeURIComponent(id)}/resume`, { method: 'POST', timeoutMs: 30000 }),
  async create(input: HairBatchInput) {
    const stored = recovery();
    if (stored.error) throw new Error(stored.error);
    const pending = stored.pending || { key: crypto.randomUUID(), input };
    localStorage.setItem(pendingKey, JSON.stringify(pending));
    try {
      const result = await request<HairBatch>(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
        body: JSON.stringify(pending.input), timeoutMs: 60000,
      });
      clearPending(pending.key);
      return result;
    } catch (error) {
      if (isDefinitiveRejection(error)) clearPending(pending.key);
      throw error;
    }
  },
};
