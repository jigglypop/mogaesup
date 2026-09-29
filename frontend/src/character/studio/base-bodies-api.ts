import { request, savedRequest } from '../api';
import type { FactoryJob } from '../factory/api';

export type BodyType = 'male' | 'female';
export type BodyView = 'front' | 'side' | 'back';
type UploadedBodyImage = { id: string; width: number; height: number; alpha: boolean };
type BaseBodyInput = {
  name: string;
  body_type: BodyType;
  views: Record<BodyView, string>;
  rig_source?: { job_id: string; version: string };
};
export type BaseBodyDraft = {
  name: string;
  views: Partial<Record<BodyView, string>>;
  rig_source?: { job_id: string; version: string };
};

const draftKey = (bodyType: BodyType) => `gaesup.base-body-draft:${bodyType}`;
const defaults: Record<BodyType, string> = { male: '기본 남성형', female: '기본 여성형' };
const views: BodyView[] = ['front', 'side', 'back'];

export function readBaseBodyDraft(bodyType: BodyType): BaseBodyDraft {
  try {
    const value = JSON.parse(localStorage.getItem(draftKey(bodyType)) || 'null') as BaseBodyDraft | null;
    const savedViews = value?.views && typeof value.views === 'object' ? value.views : {};
    return {
      name: typeof value?.name === 'string' ? value.name : defaults[bodyType],
      views: Object.fromEntries(views.flatMap(view => typeof savedViews[view] === 'string' && /^[a-f0-9]{64}$/.test(savedViews[view]!) ? [[view, savedViews[view]]] : [])),
      ...(value?.rig_source && typeof value.rig_source.job_id === 'string' && typeof value.rig_source.version === 'string'
        ? { rig_source: value.rig_source } : {}),
    };
  } catch { return { name: defaults[bodyType], views: {} }; }
}

export function saveBaseBodyDraft(bodyType: BodyType, draft: BaseBodyDraft) {
  localStorage.setItem(draftKey(bodyType), JSON.stringify(draft));
}

const baseBodies = (bodyType: BodyType) => savedRequest<BaseBodyInput>(`gaesup.base-body:${bodyType}`, ({ input }) =>
  input.body_type === bodyType && typeof input.name === 'string' && !!input.name.trim()
    && views.every(view => typeof input.views?.[view] === 'string' && /^[a-f0-9]{64}$/.test(input.views[view]))
    && (input.rig_source == null || (typeof input.rig_source.job_id === 'string' && typeof input.rig_source.version === 'string')),
  '저장된 기본 몸 요청을 읽을 수 없습니다. 기존 요청 기록을 확인해 주세요.');

export const baseBodiesApi = {
  recovery: (bodyType: BodyType) => baseBodies(bodyType).read(),
  imageUrl: (id: string) => `/api/avatar-blueprints/assets/${encodeURIComponent(id)}`,
  upload: (file: File) => request<UploadedBodyImage>('/api/avatar-blueprints/assets', {
    method: 'POST', headers: { 'Content-Type': file.type || 'image/png' }, body: file, timeoutMs: 60000,
  }),
  create: (input: BaseBodyInput) => baseBodies(input.body_type).send(input, pending => request<FactoryJob>('/api/avatar-factory/base-bodies', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.key },
    body: JSON.stringify(pending.input), timeoutMs: 60000,
  })),
};
