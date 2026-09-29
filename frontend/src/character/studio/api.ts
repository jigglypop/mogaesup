import { request, savedRequest } from '../api';
import type { FactoryJob, FitProfile } from '../factory/api';
import type { ExpressionName, FaceLayout } from '../texture-expressions';
import type { MeshyOptions } from './meshy-options';

export type PartMetadata = { name?: string; deleted?: boolean };
export type Catalog = { revision: string; items: Record<string, { name?: string; archived?: boolean; deleted?: boolean }>; parts: Record<string, PartMetadata>; characters?: Record<string, { deleted?: boolean }> };
export function isCatalogJobDeleted(job: FactoryJob, catalog?: Catalog) {
  return !!(catalog?.items[job.id]?.deleted || catalog?.characters?.[job.character_id || job.id]?.deleted);
}
type SinglePartInput = { base_job_id: string; base_version: string; slot: string; hair_length: 'source' | 'short' | 'long'; bottom_kind: 'source' | 'pants' | 'skirt'; view_mode?: 'front_side' | 'front_side_back'; fit_profile?: FitProfile; meshy_options?: MeshyOptions; part_method?: 'isolated' | 'body_shell' | 'worn'; model_provider?: 'meshy' | 'tripo' };
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
type AnimalReference = { id: string; width: number; height: number };
type AnimalCreateInput = { name: string; species: Animal['species']; reference: string };
const animalRegeneration = (id: string) => savedRequest<AnimalRegenerateInput>(`gaesup.studio.animal-regenerate.${id}.v1`,
  ({ input }) => Array.isArray(input.views) && typeof input.note === 'string' && typeof input.model === 'boolean' && typeof input.rig === 'boolean',
  '저장된 재생성 요청을 읽을 수 없습니다. 브라우저 저장소의 요청 기록을 확인해 주세요.');
const animalCreation = savedRequest<AnimalCreateInput>('gaesup.studio.animal-create.v1',
  ({ input }) => typeof input.name === 'string' && !!input.name.trim() && input.name.trim().length <= 80 && input.species === 'dog'
    && typeof input.reference === 'string' && /^[a-f0-9]{64}$/.test(input.reference),
  '저장된 동물 추가 요청을 읽을 수 없습니다. 브라우저 저장소의 요청 기록을 확인해 주세요.');

/** Forget a saved request once the server shows its job: its request is safe on the server from then on. */
function settleAnimalRecovery(animal: Animal) {
  const { pending } = animalRegeneration(animal.id).read();
  if (!pending || animal.production?.request_key !== pending.key) return false;
  animalRegeneration(animal.id).settle(pending.key);
  return true;
}

// Any answer for a key settles it: its job is current, finished, or replaced by a newer request.
const regenerateAnimal = (id: string, input: AnimalRegenerateInput, key?: string) => animalRegeneration(id).send(input, pending =>
  request<Animal>(`/api/studio/animals/${id}/regenerate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
    body: JSON.stringify(pending.input), timeoutMs: 60000,
  }), key ? { key } : {});

const createAnimal = (input: AnimalCreateInput) => animalCreation.send(input, pending => request<Animal>('/api/studio/animals', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
  body: JSON.stringify(pending.input), timeoutMs: 60000,
}));
export type HeadPartAsset = { name: string; sha256: string; url: string };
export type Expression = { id: string; name: ExpressionName; layout: FaceLayout; materials: {material:number;file:string;base_file?:string}[]; artifacts:{name:string;url:string;sha256:string}[]; head?: HeadPartAsset };
type ExpressionLibrary = { items: Expression[]; selected: string | null; revision: string };
const singlePartSlots = ['hair', 'hat', 'top', 'bottom', 'shoes', 'weapon', 'tool', 'glasses'];
const singleParts = savedRequest<SinglePartInput>('gaesup.studio.single-part.v1', ({ input }) =>
  typeof input.base_job_id === 'string' && typeof input.base_version === 'string'
    && singlePartSlots.includes(input.slot)
    && ['source', 'short', 'long'].includes(input.hair_length)
    && ['source', 'pants', 'skirt'].includes(input.bottom_kind)
    && (input.fit_profile == null || typeof input.fit_profile === 'object')
    && (input.view_mode == null || ['front_side', 'front_side_back'].includes(input.view_mode)),
  '저장된 단일 파츠 요청을 읽을 수 없습니다. 기존 요청 기록을 확인해야 새 생성을 접수할 수 있습니다.');
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
  animalCreateRecovery: animalCreation.read,
  regenerateAnimal,
  animalRecovery: (id: string) => animalRegeneration(id).read(),
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
  singlePartRecovery: singleParts.read,
  singlePart: (input: SinglePartInput) => singleParts.send(input, pending => request<FactoryJob>('/api/avatar-factory/variants/single-part', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key }, body: JSON.stringify(pending.input),
  })),
  textures: (signal?: AbortSignal) => request<{ items: Tile[] }>('/api/studio/textures', { signal }),
  texture: (input: { surface: string; size: number; seed: number }) => request<Tile>('/api/studio/textures', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }),
};
