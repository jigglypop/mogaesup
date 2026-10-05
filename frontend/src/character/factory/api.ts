import { isDefinitiveRejection, request, savedRequest, type Pending } from '../api';
import type { MeshyOptions } from '../studio/meshy-options';

export type ImageRetry = { slot: string; view: string; failure_id: string };
export type FitAnchor = { name: string; source: [number, number, number]; target?: [number, number, number] };
export type FitProfile = {
  revision?: 'garment-fit-v1';
  sleeve?: 'source' | 'none' | 'short' | 'long';
  kind?: 'source' | 'pants' | 'skirt';
  ease?: 'source' | 'regular' | 'loose';
  region_ease?: Partial<Record<'torso' | 'sleeve' | 'hip', 'source' | 'regular' | 'loose'>>;
  length_ratio?: number | null;
  sleeve_ratio?: number | null;
  anchors?: FitAnchor[];
  source_sha256?: string;
};
export type PartMethod = 'isolated' | 'body_shell' | 'worn';
export type FactoryJob = {
  meshy_options?: Record<string, MeshyOptions>;
  id: string; character_id: string; character_name: string; source_sha256: string;
  status: string; created_at: string; error?: string; model_sha256?: string;
  base_job_id?: string; base_version?: string; requested_slots?: string[]; part_name?: string;
  base_body?: { body_type: 'male' | 'female'; import_mode?: 'register' | 'rig'; views?: Partial<Record<'front' | 'side' | 'back', string>>; rig_source?: { job_id: string; version: string } | null };
  assembly_version?: string | null;
  assembly_origin?: string | null;
  assembly_artifacts?: { name: string; url: string; sha256: string }[];
  updated_at?: string;
  character_flow?: { status: string; stage: string; message: string; busy: boolean };
  production_spec?: { id: string; sha256: string; body_height_m: number; generated_views: string[] };
  reference_preparation?: { status: string; revision: string; file?: string; sha256?: string; raw_file?: string; failure?: { message?: string };
    views?: Record<string, { status: string; file?: string; sha256?: string; raw_file?: string; failure?: { message?: string } }> };
  production_progress?: { percent: number; completed: number; total: number; current: string; status: string; message: string;
    updated_at?: string; spec_id?: string; images_received?: number; images_total?: number;
    steps: { id: string; label: string; state: string; percent: number | null; completed: number; total: number }[] };
  progress: { stage: string; message: string }; outfit?: { body: string; equipment: Record<string, string> };
  profile?: { id: string; name: string; rig: string; head_ratio: number };
  technical?: { passed: boolean; bone_count: number; parts: number; source_preserved: boolean; file_bytes?: number; texture_pixels?: number; resource_warnings?: string[] };
  artifacts: { name: string; url: string; sha256?: string }[];
  evidence?: { segmentation: string; source_triangles: number; part_triangles: Record<string, number>; limitations: string[] };
  input_kind?: string;
  production_mode?: 'legacy' | 'character_parts';
  image_provider?: string; image_model?: string;
  parts?: { slot: string; part_method?: PartMethod; image_status: string; image_asset?: string; model_status: string; task_id?: string; progress?: number; reused?: boolean; assembly_status?: 'pending' | 'running' | 'failed' | 'complete'; image_failure?: { id: string; category: string }; views?: Record<string, {status: string; file?: string; qc?: {passed: boolean; issues: string[]}; failure?: {id: string; message?: string; elapsed_seconds?: number}}> }[];
  limits?: { image_tasks: number; meshy_tasks: number; reference_tasks?: number; expression_tasks?: number };
  next_actions?: { id: string; enabled: boolean; reason?: string; slot?: string; view?: string; failure_id?: string; images?: ImageRetry[]; warning?: string }[];
};
type ImageProductionInput = { meshy_options?: MeshyOptions; character_id: string; source_sha256: string; blueprint_revision: string; image_mode: 'generate' | 'prepared'; slots: string[]; production_mode?: 'legacy' | 'character_parts'; view_mode?: 'single' | 'front_side' | 'front_side_back'; hair_length?: 'source' | 'short' | 'long'; reuse_job_id?: string; rig_with_meshy?: boolean; body_purpose?: 'whole_character' | 'wardrobe_base'; motion_actions?: Record<string, number>; design_prompts?: Record<string, string>; prepare_reference?: boolean; default_expressions?: boolean; base_job_id?: string; base_version?: string; fit_profiles?: { top?: FitProfile; bottom?: FitProfile } };
export type FactoryCapabilities = { character_pipeline?: string; ready: boolean; meshy_balance?: number | null; meshy_credit_estimate?: { part: number; rig: number }; image_provider: string; image_model: string; slots: string[]; design_prompt_defaults?: Record<string, string>; meshy_model: string; image_configured: boolean; meshy_configured: boolean; tripo_configured?: boolean; model_providers?: ('meshy' | 'tripo')[]; default_model_provider?: 'meshy' | 'tripo'; part_methods?: { defaults: Partial<Record<string, PartMethod>> }; blender_available: boolean; next_actions: { id: string; enabled: boolean; reason?: string }[] };
export type MeshyAction = { action_id: number; name: string; key: string; category: string; sub_category: string; preview_url?: string };
export type MeshyState = { provider: 'meshy'; status: string; rig_task_id?: string; progress: number; busy: boolean; error?: string;
  origin?: string; can_request_action?: boolean;
  version?: string; model_sha256?: string; bone_count?: number; can_resume: boolean; artifacts: {name: string; url: string}[];
  clips: {slot: string; source: string; action_id: number | null}[]; selected: Record<string, number>;
  actions: {action_id: number; task_id?: string; status?: string; progress?: number}[] };
/** Pre-rig ring measurement of sleeves / trouser legs against the body (worn parts). */
export type LimbFitCheck = { status: 'pass' | 'fail' | 'unchecked' | 'not_applicable'; failures: { limb: string; message: string }[];
  limbs: Record<string, { rings?: number; min_margin_cm?: number; angle_deg?: number | null }> };
export type NativeDelivery = Record<string, {
  artifact: string; sha256: string; source_sha256: string; source_bytes: number; runtime_bytes: number; method: string;
  geometry_preserved: boolean; uv_skin_animation_images_preserved: boolean;
}>;
export type NativeQuality = {
  revision: string; status: string; visual_review: string; production_spec_sha256: string;
  artifacts: Record<string, string>; delivery: NativeDelivery;
  checks: { code: string; status: string; slot?: string; actual?: number; target?: number }[];
  rear_coverage?: { rays: number; covered: number; ratio: number; geometric_ratio: number } | null;
  parts: Record<string, { triangles?: number; penetration?: { vertices: number; inside: number; ratio: number } }>;
  runtime: { file_bytes?: number; vertices?: number; triangles?: number; meshes?: number; materials?: number;
    skins?: number; texture_pixels?: number | null; animations?: string[]; joints?: string[] };
};
export type NativePartsState = {
  origin?: string;
  rigged?: boolean;
  status: string; version?: string; error?: string; bone_count?: number; visual_review?: string;
  assembly_sha256?: string;
  review?: { status: 'required' | 'approved' | 'changes_requested' | 'stale'; decision?: 'approved' | 'changes_requested'; id?: string;
    assembly_sha256?: string; reviewed_at?: string; reviewer_id?: number; reviewer_name?: string; notes?: string; appearance_checked?: boolean; motion_checked?: boolean; target_fingerprint?: string };
  fitting_revision?: string; fit_update_available?: boolean; expression_pending?: boolean; fit_status?: string;
  refit_request_key?: string | null;
  incomplete_parts?: { slot: string; status: string; errors: { code: string; message: string }[] }[];
  parts: { slot: string; objects: string[]; available?: boolean; fit_method?: string; unavailable_reason?: string; runtime_budget?: {
    source_triangles?: number; runtime_triangles?: number; target_triangles?: number;
    texture_max_edge?: number; resized_textures?: number; source_files_preserved?: boolean; budget_met?: boolean;
  }; limb_fit?: { check?: LimbFitCheck } }[];
  artifacts: { name: string; url: string; sha256: string }[];
  quality?: NativeQuality;
  delivery?: NativeDelivery;
  preview?: NativePartsState;
};
/** A lossless derivative belongs to the exact source version and artifact named by its receipt. */
export function nativeArtifact(state: NativePartsState, slot: string) {
  const source = state.artifacts.find(item => item.name === `${slot}.glb`);
  const receipt = state.delivery?.[slot];
  const runtime = receipt && state.artifacts.find(item => item.name === `${slot}.runtime.glb`);
  return source && runtime && receipt.artifact === runtime.name && receipt.source_sha256 === source.sha256
    && receipt.sha256 === runtime.sha256 && receipt.geometry_preserved && receipt.uv_skin_animation_images_preserved
    ? runtime : source;
}
export type NativeOutfit = { version: string; body_sha256: string; revision: string; slots: string[]; hair_color?: string | null; saved_at?: string };
export type BodyProfileState = { revision: string; body: null | { job_id: string; version: string; profile_id: string; body_sha256: string } };
export type WardrobeBody = { job_id: string; version: string; profile_id: string; body_sha256: string; geometry_sha256: string; name: string; body_type?: 'male' | 'female' | null; registered_at: string; is_default: boolean; part_jobs: number | null };
type WardrobeBodiesState = { revision: string; bodies: WardrobeBody[]; default: null | { job_id: string; version: string } };
/** Body-shell garment shape: sleeve 0 (none)..1 (wrist); hem top waist..crotch, bottom shorts..ankle. */
export type GarmentShape = { sleeve?: number; hem?: number; fit?: 'tight' | 'normal' | 'loose' };
export type WardrobePart = { job_id: string; version: string; slot: string; name: string; character_name?: string | null; fit_method?: string | null;
  shape?: GarmentShape | null;
  runtime_name?: string | null; runtime_sha256?: string | null;
  fit_check?: { status: 'pass' | 'fail'; failures: string[] } | null; sha256: string; created_at?: string | null };
/** A part whose fitting did not produce a wearable file: `reason` is a code (needs_anchors, garment_fit_incomplete, fit_exception, ...). */
export type WardrobeUnavailable = { job_id: string; version: string; slot: string; name: string; reason: string };
type WardrobeParts = { body: WardrobeBody; parts: WardrobePart[]; unavailable?: WardrobeUnavailable[] };
export type WardrobePartRef = { job_id: string; version: string; sha256: string };
export type WardrobeOutfit = { name: string; body: { job_id: string; version: string }; parts: Record<string, WardrobePartRef>; hair_color?: string | null; colors?: Record<string, Record<string, string>>; saved_at?: string };
export type WardrobeColors = { slot: string; material: number; regions: { index: number; color: string; share: number; light: number }[] };
type WardrobeOutfits = { revision: string; outfits: Record<string, WardrobeOutfit> };
/** An inner garment, per "mesh:primitive": anchors, base64 int32 per vertex, the body vertex under it
 * (anchor_keys index << 20 | vertex) or -1; tucks, base64 float32 x, y, z per vertex, the move in
 * vertex space that presses it onto the skin. under: the outer slots it tucks under. A part covering
 * the head (covers_head) also has over: the head triangles hair tucks under (a hat's crown stands off the scalp). */
export type WardrobeCoverage = { slot: string; hidden: Record<string, string>; triangles: Record<string, number>; covers_bottom: boolean; covers_head?: boolean; boot?: boolean; over?: Record<string, string>;
  anchors?: Record<string, string>; tucks?: Record<string, string>; anchor_keys?: string[]; under?: string[] };
const wardrobeRuntime = (part: WardrobePart) => part.runtime_name === `${part.slot}.runtime.glb` && !!part.runtime_sha256;
/** Download identity only; saved outfits, fitting and coverage remain bound to the source hash. */
export const wardrobePartSha = (part: WardrobePart) => wardrobeRuntime(part) ? part.runtime_sha256! : part.sha256;
export const wardrobeUrls = {
  body: (body: { job_id: string; version: string }) => `/api/avatar-factory/jobs/${body.job_id}/native-parts/${body.version}/body.glb`,
  part: (part: WardrobePart) => `/api/avatar-factory/jobs/${part.job_id}/native-parts/${part.version}/${wardrobeRuntime(part) ? part.runtime_name : `${part.slot}.glb`}`,
  preview: (part: WardrobePart) => `/api/avatar-factory/wardrobe/previews/${part.job_id}/${part.slot}?${new URLSearchParams({ version: part.version })}`,
  colorMask: (part: WardrobePart) => `/api/avatar-factory/wardrobe/colors/${part.job_id}/${part.slot}/mask?${new URLSearchParams({ version: part.version })}`,
};
export type PartFitProfile = { slot: 'top' | 'bottom'; source_version: string; source_sha256: string; fit_profile: FitProfile; measurement?: Record<string, unknown>; body_profile?: Record<string, unknown> };
export type NativePartsVersions = { current: string | null; items: { version: string; created_at?: string; fitting_revision?: string; url?: string;
  assembly_sha256?: string; review?: NativePartsState['review']; incomplete_parts?: NativePartsState['incomplete_parts'] }[] };
export type FactoryStage = 'images' | 'models' | 'rig' | 'assemble' | 'expressions';
type FactoryStages = {
  busy: boolean; recommended_stage: FactoryStage | null;
  actions: { stage: FactoryStage; enabled: boolean; reason: string | null; paid: boolean; warning?: string }[];
  saved: { images: number; images_total: number; models: number; models_total: number; rig: boolean };
  operation: { id: string; stage: FactoryStage; status: string; error: string | null; created_at: string; updated_at: string } | null;
};
export type RigTransferInput = { source_job_id: string; source_version: string };
type RigTransferState = {
  status: 'not_started' | 'accepted' | 'running' | 'paused' | 'complete'; can_start: boolean; error?: string;
  source_job_id?: string; source_version?: string; id?: string; request_key?: string;
  recommended_source?: RigTransferSource | null;
};
export type RigTransferSource = { job_id: string; version: string; name: string };
const imagePendingKey = (id: string) => `gaesup.image-production:${id}`;
const imageRequests = (id: string) => savedRequest<ImageProductionInput>(imagePendingKey(id), ({ input }) =>
  input.character_id === id && typeof input.source_sha256 === 'string' && typeof input.blueprint_revision === 'string'
    && ['generate', 'prepared'].includes(input.image_mode)
    && Array.isArray(input.slots) && input.slots.length > 0 && input.slots.every(slot => typeof slot === 'string')
    && (input.base_job_id == null || typeof input.base_job_id === 'string') && (input.base_version == null || typeof input.base_version === 'string')
    && (input.hair_length == null || ['source', 'short', 'long'].includes(input.hair_length))
    && (input.view_mode == null || ['single', 'front_side', 'front_side_back'].includes(input.view_mode))
    && (input.meshy_options == null || typeof input.meshy_options === 'object'),
  '저장된 이미지 생성 요청을 읽을 수 없습니다. 기존 요청 기록을 확인해야 새 생성을 접수할 수 있습니다.');
const nativePartsSelectionKey = (id: string) => `gaesup.native-parts-selection:${id}`;
type PendingNativePartsSelection = { key: string; input: { version: string; expected_version: string } };
type RefitInput = { source_version: string; slot: string; fit_profile?: FitProfile; part_method?: 'isolated' | 'body_shell'; shape?: GarmentShape };
const refits = (id: string) => savedRequest<RefitInput>(`gaesup.part-refit:${id}`,
  ({ input }) => typeof input.source_version === 'string' && typeof input.slot === 'string', '저장된 피팅 요청을 확인할 수 없습니다.');
const postRefit = (id: string) => (pending: Pending<RefitInput>) => request<NativePartsState>(`/api/avatar-factory/jobs/${id}/native-parts/refit`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key }, body: JSON.stringify(pending.input),
});
export const factoryApi = {
  nativeParts: (id: string, signal?: AbortSignal) => request<NativePartsState>(`/api/avatar-factory/jobs/${id}/native-parts`, { signal }),
  assemble: (id: string, canonicalPose = false) => request<NativePartsState>(`/api/avatar-factory/jobs/${id}/native-parts?canonical_pose=${canonicalPose}`, { method: 'POST' }),
  reviewNative: (id: string, version: string, input: { expected_assembly_sha256: string; decision: 'approved' | 'changes_requested'; appearance_checked: boolean; motion_checked: boolean; notes: string }, key: string) =>
    request<NativePartsState>(`/api/avatar-factory/jobs/${id}/native-parts/${version}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input) }),
  nativeOutfit: (id: string, version: string, signal?: AbortSignal) => request<NativeOutfit>(`/api/avatar-factory/jobs/${id}/native-outfits/${version}`, { signal }),
  saveNativeOutfit: (id: string, version: string, input: Pick<NativeOutfit, 'body_sha256' | 'slots' | 'hair_color'>, revision: string, key: string) =>
    request<NativeOutfit>(`/api/avatar-factory/jobs/${id}/native-outfits/${version}`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': revision, 'Idempotency-Key': key }, body: JSON.stringify(input) }),
  motionLibrary: (signal?: AbortSignal) => request<{items: MeshyAction[]}>('/api/avatar-factory/motion-library', { signal }),
  motionDefaults: (jobId?: string, signal?: AbortSignal) => request<{selections: Record<string, number>}>(jobId ? `/api/avatar-factory/jobs/${jobId}/motion-defaults` : '/api/avatar-factory/motion-defaults', { signal }),
  saveMotionDefaults: (selections: Record<string, number>, jobId?: string) => request<{selections: Record<string, number>}>(jobId ? `/api/avatar-factory/jobs/${jobId}/motion-defaults` : '/api/avatar-factory/motion-defaults', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({selections})}),
  meshy: (id: string, signal?: AbortSignal) => request<MeshyState>(`/api/avatar-factory/jobs/${id}/meshy`, {signal}),
  meshyRig: (id: string) => request<MeshyState>(`/api/avatar-factory/jobs/${id}/meshy/rig`, {method:'POST'}),
  meshyRecover: (id: string, task_id: string, action_id?: number) => request<MeshyState>(`/api/avatar-factory/jobs/${id}/meshy/recover`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({task_id,action_id})}),
  meshyAction: (id: string, slot: string, action_id: number) => request<MeshyState>(`/api/avatar-factory/jobs/${id}/meshy/actions`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slot,action_id})}),
  capabilities: (signal?: AbortSignal) => request<FactoryCapabilities>('/api/avatar-factory/capabilities', { signal }),
  stages: (id: string, signal?: AbortSignal) => request<FactoryStages>(`/api/avatar-factory/jobs/${id}/stages`, { signal }),
  bodyProfile: (signal?: AbortSignal) => request<BodyProfileState>('/api/avatar-factory/body-profile', { signal }),
  saveBodyProfile: (job_id: string, version: string, expected_revision: string) => request<BodyProfileState>('/api/avatar-factory/body-profile', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id, version, expected_revision }),
  }),
  wardrobeBodies: (signal?: AbortSignal) => request<WardrobeBodiesState>('/api/avatar-factory/wardrobe/bodies', { signal }),
  registerWardrobeBody: (job_id: string, version: string, expected_revision: string) => request<WardrobeBodiesState>(`/api/avatar-factory/wardrobe/bodies/${job_id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version, expected_revision }),
  }),
  unregisterWardrobeBody: (job_id: string, revision: string) => request<WardrobeBodiesState>(`/api/avatar-factory/wardrobe/bodies/${job_id}`, {
    method: 'DELETE', headers: { 'If-Match': revision },
  }),
  wardrobeParts: (bodyJobId: string, signal?: AbortSignal) => request<WardrobeParts>(`/api/avatar-factory/wardrobe/bodies/${bodyJobId}/parts`, { signal }),
  wardrobeOutfits: (signal?: AbortSignal) => request<WardrobeOutfits>('/api/avatar-factory/wardrobe/outfits', { signal }),
  /** Why a part's wardrobe picture (an image, so not read through `request`) did not load: the server has none of it
   * (`missing`, 404 preview_missing), it loads now (`ok`), or the request failed. */
  async wardrobePreviewAnswer(part: WardrobePart, signal?: AbortSignal): Promise<'missing' | 'ok' | 'failed'> {
    try {
      const response = await fetch(wardrobeUrls.preview(part), { signal });
      if (response.ok) { void response.body?.cancel().catch(() => undefined); return 'ok'; }
      const body = await response.json().catch(() => null) as { error?: { code?: unknown } } | null;
      return response.status === 404 && body?.error?.code === 'preview_missing' ? 'missing' : 'failed';
    } catch { return 'failed'; }
  },
  wardrobeColors: (part: WardrobePart, signal?: AbortSignal) => request<WardrobeColors>(
    `/api/avatar-factory/wardrobe/colors/${part.job_id}/${part.slot}?${new URLSearchParams({ version: part.version })}`, { signal }),
  wardrobeCoverage: (bodyJobId: string, part: WardrobePart, signal?: AbortSignal) => request<WardrobeCoverage>(
    `/api/avatar-factory/wardrobe/bodies/${bodyJobId}/coverage/${part.job_id}/${part.slot}?${new URLSearchParams({ version: part.version })}`, { signal }),
  saveWardrobeOutfit: (id: string, input: WardrobeOutfit, revision: string, key: string) => request<WardrobeOutfits>(`/api/avatar-factory/wardrobe/outfits/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': revision, 'Idempotency-Key': key }, body: JSON.stringify(input),
  }),
  deleteWardrobeOutfit: (id: string, revision: string) => request<WardrobeOutfits>(`/api/avatar-factory/wardrobe/outfits/${id}`, {
    method: 'DELETE', headers: { 'If-Match': revision },
  }),
  fitProfile: (id: string, slot: 'top' | 'bottom', sourceVersion: string, signal?: AbortSignal) => request<PartFitProfile>(`/api/avatar-factory/jobs/${id}/fit-profile/${slot}?${new URLSearchParams({ source_version: sourceVersion })}`, { signal }),
  nativePartsVersions: (id: string, signal?: AbortSignal) => request<NativePartsVersions>(`/api/avatar-factory/jobs/${id}/native-parts/versions`, { signal }),
  pendingNativePartsSelection: (id: string): PendingNativePartsSelection | null => {
    const raw = localStorage.getItem(nativePartsSelectionKey(id));
    if (!raw) return null;
    const value = JSON.parse(raw) as PendingNativePartsSelection;
    if (typeof value?.key !== 'string' || !value.key || typeof value.input?.version !== 'string'
      || typeof value.input?.expected_version !== 'string') throw new Error('저장된 버전 전환 요청을 확인할 수 없습니다.');
    return value;
  },
  async selectNativePartsVersion(id: string, version: string, expected_version: string) {
    const storage = nativePartsSelectionKey(id);
    const pending = factoryApi.pendingNativePartsSelection(id) || { key: crypto.randomUUID(), input: { version, expected_version } };
    localStorage.setItem(storage, JSON.stringify(pending));
    try {
      const result = await request<NativePartsState>(`/api/avatar-factory/jobs/${id}/native-parts/select`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key }, body: JSON.stringify(pending.input),
      });
      localStorage.removeItem(storage); return result;
    } catch (error) {
      if (isDefinitiveRejection(error)) localStorage.removeItem(storage);
      throw error;
    }
  },
  /** The job's refit whose answer was lost, if any; throws when what is saved cannot be read. */
  pendingRefit: (id: string): Pending<RefitInput> | null => {
    const { pending, error } = refits(id).read();
    if (error) throw new Error(error);
    return pending;
  },
  /** Forgets the saved refit sent under `key` (the server has it, or someone cleared it). */
  acknowledgeRefit: (id: string, key: string) => refits(id).settle(key),
  /** Refits a part. A saved refit is replayed only as itself: with a different one saved (another part, another shape) this
   * refuses with PendingRequestConflict rather than send the saved one in place of this one; see `resumeRefit`. */
  refitPart: (id: string, source_version: string, slot: string, fit_profile?: FitProfile, part_method?: 'isolated' | 'body_shell', shape?: GarmentShape) =>
    refits(id).send({ source_version, slot, ...(fit_profile ? { fit_profile } : {}), ...(part_method ? { part_method } : {}), ...(shape ? { shape } : {}) }, postRefit(id)),
  /** Sends the saved refit again, its own input under its own key. */
  resumeRefit(id: string) {
    const pending = factoryApi.pendingRefit(id);
    if (!pending) throw new Error('저장된 피팅 요청이 없습니다.');
    return refits(id).send(pending.input, postRefit(id));
  },
  resumeStage: (id: string, stage: FactoryStage, key: string) => request<FactoryStages>(`/api/avatar-factory/jobs/${id}/stages/${stage}/resume`, {
    method: 'POST', headers: { 'Idempotency-Key': key },
  }),
  rigTransfer: (id: string, signal?: AbortSignal) => request<RigTransferState>(`/api/avatar-factory/jobs/${id}/rig-transfer`, { signal }),
  rigTransferSources: (signal?: AbortSignal) => request<{items: RigTransferSource[]}>('/api/avatar-factory/rig-transfer/sources', { signal, timeoutMs: 30000 }),
  startRigTransfer: (id: string, input: RigTransferInput, key: string) => request<RigTransferState>(`/api/avatar-factory/jobs/${id}/rig-transfer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input),
  }),
  retryImages: (id: string, images: ImageRetry[]) => request<FactoryJob>(`/api/avatar-factory/jobs/${id}/retry-images`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images }),
  }),
  /** The character's saved image request, if the browser still has one; `error` when what it holds cannot be read. */
  imageRecovery: (id: string) => {
    // An older version kept it for the tab's session only.
    try {
      const key = imagePendingKey(id), legacy = sessionStorage.getItem(key);
      if (legacy !== null) { if (!localStorage.getItem(key)) localStorage.setItem(key, legacy); sessionStorage.removeItem(key); }
    } catch { /* Storage is closed; the saved request cannot be read either. */ }
    return imageRequests(id).read();
  },
  /** Starts an image production. A saved request is replayed only as itself: pass its key as `replay` with its own input;
   * with another one saved this refuses rather than send the saved one in place of `input`. */
  async produceImage(input: ImageProductionInput, replay?: string): Promise<FactoryJob> {
    const { pending, error } = factoryApi.imageRecovery(input.character_id);
    if (error) throw new Error(error);
    if (pending && pending.key !== replay) throw new Error('저장된 이미지 생성 요청이 있습니다. 같은 요청을 복구한 뒤 다시 시도해 주세요.');
    return imageRequests(input.character_id).send(input, saved => request<FactoryJob>('/api/avatar-factory/image-jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': saved.key }, body: JSON.stringify(saved.input),
    }));
  },
  detail: (id: string, signal?: AbortSignal) => request<FactoryJob>(`/api/avatar-factory/jobs/${id}`, { signal }),
  list: (signal?: AbortSignal) => request<{ jobs: FactoryJob[] }>('/api/avatar-factory/jobs', { signal, timeoutMs: 60000 }),
};
