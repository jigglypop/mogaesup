import { isDefinitiveRejection, request } from '../api';
import type { FactoryJob, FitProfile } from '../factory/api';
import type { ExpressionName, FaceLayout } from '../texture-expressions';
import type { MeshyOptions } from './meshy-options';

export type PartMetadata = { name?: string; deleted?: boolean };
export type Catalog = { revision: string; items: Record<string, { name?: string; archived?: boolean; deleted?: boolean }>; parts: Record<string, PartMetadata>; characters?: Record<string, { deleted?: boolean }> };
export function isCatalogJobDeleted(job: FactoryJob, catalog?: Catalog) {
  return !!(catalog?.items[job.id]?.deleted || catalog?.characters?.[job.character_id || job.id]?.deleted);
}
export type VariantInput = { base_job_id: string; base_version: string; slots: string[]; hair_length: 'source' | 'short' | 'long'; bottom_kind?: 'source' | 'pants' | 'skirt'; descriptions: Record<string, string>; meshy_options?: MeshyOptions };
export type SinglePartInput = { base_job_id: string; base_version: string; slot: string; hair_length: 'source' | 'short' | 'long'; bottom_kind: 'source' | 'pants' | 'skirt'; view_mode?: 'front_side' | 'front_side_back'; fit_profile?: FitProfile; meshy_options?: MeshyOptions; part_method?: 'isolated' | 'body_shell' | 'worn'; model_provider?: 'meshy' | 'tripo' };
export type Tile = { id: string; surface: string; size: number; seed: number; gpu: { estimated_bytes_with_mips: number }; artifacts: { name: string; url: string }[] };
export type AnimalView = 'front' | 'left' | 'back' | 'right';
export type AnimalStages = {
  views: { status: string; provider: string; images: number; redrawn?: AnimalView[]; height?: number } | null;
  model: { status: string; provider: string; triangles?: number; credits?: number | null } | null;
  rig: { status: string; provider: string; rig_type?: string; bones?: number } | null;
  walk: { status: string; provider: string; frames?: number; fps?: number; grounded_paws?: number; paws?: number } | null;
  standard: { status: string; provider: string; bones?: number; clips?: string[]; grounded_paws?: number; paws?: number } | null;
};
export type AnimalStep = 'views' | 'model' | 'rig';
/** Where a running job is: the view being drawn (views step) or the Meshy task's percentage (model step). */
export type AnimalProgress = { current?: AnimalView | null; done?: number; total?: number; percent?: number | null };
export type AnimalProduction = { id: string; request_key: string; status: 'accepted' | 'running' | 'paused' | 'blocked' | 'failed' | 'complete';
  step: AnimalStep | null; steps: AnimalStep[]; done: AnimalStep[]; views: AnimalView[]; note: string; error?: string | null;
  created_at?: string; updated_at?: string; progress?: AnimalProgress | null };
export type Animal = { id: string; name: string; species: 'dog'; order?: number; created_at: string; stages: AnimalStages;
  production: AnimalProduction | null; artifacts: { name: string; url: string; sha256: string }[] };
export type AnimalRegenerateInput = { views: AnimalView[]; note: string; model: boolean; rig: boolean };
export type AnimalReference = { id: string; width: number; height: number };
export type AnimalCreateInput = { name: string; species: Animal['species']; reference: string };
type PendingAnimalRequest = { key: string; input: AnimalRegenerateInput };
type PendingAnimalCreate = { key: string; input: AnimalCreateInput };
const animalPendingKey = (id: string) => `gaesup.studio.animal-regenerate.${id}.v1`;
const animalCreateKey = 'gaesup.studio.animal-create.v1';

export function animalRecovery(id: string): { pending: PendingAnimalRequest | null; error: string } {
  try {
    const raw = localStorage.getItem(animalPendingKey(id));
    if (!raw) return { pending: null, error: '' };
    const pending = JSON.parse(raw) as PendingAnimalRequest;
    const input = pending?.input;
    if (!pending || typeof pending.key !== 'string' || !pending.key || !input || !Array.isArray(input.views)
      || typeof input.note !== 'string' || typeof input.model !== 'boolean' || typeof input.rig !== 'boolean') throw new Error();
    return { pending, error: '' };
  } catch {
    return { pending: null, error: '저장된 재생성 요청을 읽을 수 없습니다. 브라우저 저장소의 요청 기록을 확인해 주세요.' };
  }
}

function clearAnimalPending(id: string, key: string) {
  if (animalRecovery(id).pending?.key === key) localStorage.removeItem(animalPendingKey(id));
}

/** Forget a saved request once the server shows its job: its request is safe on the server from then on. */
export function settleAnimalRecovery(animal: Animal) {
  const { pending } = animalRecovery(animal.id);
  if (!pending || animal.production?.request_key !== pending.key) return false;
  clearAnimalPending(animal.id, pending.key);
  return true;
}

async function regenerateAnimal(id: string, input: AnimalRegenerateInput, key?: string) {
  const recovery = animalRecovery(id);
  if (recovery.error) throw new Error(recovery.error);
  const pending = recovery.pending || { key: key || crypto.randomUUID(), input };
  localStorage.setItem(animalPendingKey(id), JSON.stringify(pending));
  try {
    const result = await request<Animal>(`/api/studio/animals/${id}/regenerate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
      body: JSON.stringify(pending.input), timeoutMs: 60000,
    });
    // Any answer for this key settles it: its job is current, finished, or replaced by a newer request.
    clearAnimalPending(id, pending.key);
    return result;
  } catch (error) {
    if (isDefinitiveRejection(error)) clearAnimalPending(id, pending.key);
    throw error;
  }
}

export function animalCreateRecovery(): { pending: PendingAnimalCreate | null; error: string } {
  try {
    const raw = localStorage.getItem(animalCreateKey);
    if (!raw) return { pending: null, error: '' };
    const pending = JSON.parse(raw) as PendingAnimalCreate;
    const input = pending?.input;
    if (!pending || typeof pending.key !== 'string' || !pending.key || !input || typeof input.name !== 'string'
      || !input.name.trim() || input.name.trim().length > 80 || input.species !== 'dog'
      || typeof input.reference !== 'string' || !/^[a-f0-9]{64}$/.test(input.reference)) throw new Error();
    return { pending, error: '' };
  } catch {
    return { pending: null, error: '저장된 동물 추가 요청을 읽을 수 없습니다. 브라우저 저장소의 요청 기록을 확인해 주세요.' };
  }
}

function clearAnimalCreate(key: string) {
  if (animalCreateRecovery().pending?.key === key) localStorage.removeItem(animalCreateKey);
}

async function createAnimal(input: AnimalCreateInput) {
  const recovery = animalCreateRecovery();
  if (recovery.error) throw new Error(recovery.error);
  const pending = recovery.pending || { key: crypto.randomUUID(), input };
  localStorage.setItem(animalCreateKey, JSON.stringify(pending));
  try {
    const result = await request<Animal>('/api/studio/animals', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
      body: JSON.stringify(pending.input), timeoutMs: 60000,
    });
    clearAnimalCreate(pending.key);
    return result;
  } catch (error) {
    if (isDefinitiveRejection(error)) clearAnimalCreate(pending.key);
    throw error;
  }
}
export type HeadPartAsset = { name: string; sha256: string; url: string };
export type Expression = { id: string; name: ExpressionName; layout: FaceLayout; materials: {material:number;file:string;base_file?:string}[]; artifacts:{name:string;url:string;sha256:string}[]; head?: HeadPartAsset };
export type ExpressionLibrary = { items: Expression[]; selected: string | null; revision: string };
const pendingKey = 'gaesup.studio.variant.v1';
const singlePartPendingKey = 'gaesup.studio.single-part.v1';
const singlePartSlots = ['hair', 'hat', 'top', 'bottom', 'shoes', 'weapon', 'tool', 'glasses'];
type PendingVariant = { key: string; input: VariantInput };
export type PendingSinglePart = { key: string; input: SinglePartInput };
function variantRecovery(): { pending: PendingVariant | null; error: string } {
  try {
    const raw = localStorage.getItem(pendingKey);
    if (!raw) return { pending: null, error: '' };
    const pending = JSON.parse(raw) as PendingVariant;
    if (!pending || typeof pending.key !== 'string' || !pending.key || !pending.input
      || typeof pending.input.base_job_id !== 'string' || typeof pending.input.base_version !== 'string'
      || !Array.isArray(pending.input.slots) || !pending.input.slots.every(slot => typeof slot === 'string')
      || !['source', 'short', 'long'].includes(pending.input.hair_length)
      || (pending.input.bottom_kind != null && !['source', 'pants', 'skirt'].includes(pending.input.bottom_kind))
      || !pending.input.descriptions || typeof pending.input.descriptions !== 'object') throw new Error();
    return { pending, error: '' };
  } catch {
    return { pending: null, error: '저장된 파츠 요청을 읽을 수 없습니다. 기존 요청 기록을 확인해야 새 생성을 접수할 수 있습니다.' };
  }
}
function clearVariant(key: string) {
  if (variantRecovery().pending?.key === key) localStorage.removeItem(pendingKey);
}
function singlePartRecovery(): { pending: PendingSinglePart | null; error: string } {
  try {
    const raw = localStorage.getItem(singlePartPendingKey);
    if (!raw) return { pending: null, error: '' };
    const pending = JSON.parse(raw) as PendingSinglePart;
    if (!pending || typeof pending.key !== 'string' || !pending.key || !pending.input
      || typeof pending.input.base_job_id !== 'string' || typeof pending.input.base_version !== 'string'
      || !singlePartSlots.includes(pending.input.slot)
      || !['source', 'short', 'long'].includes(pending.input.hair_length)
      || !['source', 'pants', 'skirt'].includes(pending.input.bottom_kind)
      || (pending.input.fit_profile != null && typeof pending.input.fit_profile !== 'object')
      || (pending.input.view_mode != null && !['front_side', 'front_side_back'].includes(pending.input.view_mode))) throw new Error();
    return { pending, error: '' };
  } catch {
    return { pending: null, error: '저장된 단일 파츠 요청을 읽을 수 없습니다. 기존 요청 기록을 확인해야 새 생성을 접수할 수 있습니다.' };
  }
}
function clearSinglePart(key: string) {
  if (singlePartRecovery().pending?.key === key) localStorage.removeItem(singlePartPendingKey);
}
export const studioApi = {
  expressions: (job: string, version: string, signal?: AbortSignal) => request<ExpressionLibrary>(`/api/studio/bodies/${job}/${version}/expressions`, {signal}),
  applyExpressionOverlay: (job: string, version: string, input: { asset_id: string; name: ExpressionName }) => request<Expression>(`/api/studio/bodies/${job}/${version}/expressions/overlay`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),timeoutMs:60000}),
  bakeExpression: (job: string, version: string, generation: string) => request<Expression>(`/api/studio/bodies/${job}/${version}/expression-generations/${generation}/bake`, {method:'POST', timeoutMs:60000}),
  selectExpression: (job: string, version: string, expression_id: string | null, revision: string) => request<{selected:string|null;revision:string}>(`/api/studio/bodies/${job}/${version}/expressions/selection`, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expression_id,revision})}),
  animals: (signal?: AbortSignal) => request<{items:Animal[]}>('/api/studio/animals',{signal}),
  uploadAnimalReference: (file: File) => request<AnimalReference>('/api/studio/animals/references', {
    method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file, timeoutMs: 60000,
  }),
  createAnimal,
  animalCreateRecovery,
  regenerateAnimal,
  animalRecovery,
  settleAnimalRecovery,
  catalog: (signal?: AbortSignal) => request<Catalog>('/api/studio/catalog', { signal }),
  setVisibility: (id: string, scope: 'character' | 'version', deleted: boolean, revision: string) => request<Catalog>(`/api/studio/catalog/${id}/visibility`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'If-Match': revision }, body: JSON.stringify({ scope, deleted }),
  }),
  saveMetadata: (id: string, name: string, archived: boolean, revision: string) => request<Catalog>(`/api/studio/catalog/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': revision }, body: JSON.stringify({ name, archived }),
  }),
  savePartMetadata: (id: string, slot: string, changes: PartMetadata, revision: string) => request<Catalog>(`/api/studio/catalog/${id}/parts/${slot}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'If-Match': revision }, body: JSON.stringify(changes),
  }),
  variantRecovery,
  singlePartRecovery,
  async singlePart(input: SinglePartInput) {
    const recovery = singlePartRecovery();
    if (recovery.error) throw new Error(recovery.error);
    const pending = recovery.pending || { key: crypto.randomUUID(), input };
    localStorage.setItem(singlePartPendingKey, JSON.stringify(pending));
    try {
      const result = await request<FactoryJob>('/api/avatar-factory/variants/single-part', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key }, body: JSON.stringify(pending.input) });
      clearSinglePart(pending.key); return result;
    } catch (e) {
      if (isDefinitiveRejection(e)) clearSinglePart(pending.key);
      throw e;
    }
  },
  async variant(input: VariantInput) {
    const recovery = variantRecovery();
    if (recovery.error) throw new Error(recovery.error);
    const pending = recovery.pending || { key: crypto.randomUUID(), input };
    localStorage.setItem(pendingKey, JSON.stringify(pending));
    try {
      const result = await request<FactoryJob>('/api/avatar-factory/variants', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key }, body: JSON.stringify(pending.input) });
      clearVariant(pending.key); return result;
    } catch (e) {
      if (isDefinitiveRejection(e)) clearVariant(pending.key);
      throw e;
    }
  },
  textures: (signal?: AbortSignal) => request<{ items: Tile[] }>('/api/studio/textures', { signal }),
  texture: (input: { surface: string; size: number; seed: number }) => request<Tile>('/api/studio/textures', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }),
};
