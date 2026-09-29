import { useMemo, useState } from 'react';

export type MeshyOptions = {
  ai_model: 'meshy-7.1'; geometry_resolution: 'standard' | '2k';
  should_texture: boolean; enable_pbr: boolean; texture_resolution: '2k' | '4k' | '8k';
  texture_mode: 'source' | 'prompt' | 'image' | 'images'; texture_image_assets: string[];
  should_remesh: boolean; topology: 'triangle' | 'quad'; target_polycount: number;
  decimation_mode: 1 | 2 | 3 | 4 | null; save_pre_remeshed_model: boolean;
  pose_mode: '' | 'a-pose' | 't-pose'; image_enhancement: boolean; remove_lighting: boolean;
  moderation: boolean; target_formats: ('glb' | 'obj' | 'fbx' | 'stl' | 'usdz' | '3mf')[];
  auto_size: boolean; origin_at: 'bottom' | 'center'; alpha_thumbnail: boolean; multi_view_thumbnails: boolean;
};
export const defaultMeshyOptions: MeshyOptions = {
  ai_model: 'meshy-7.1', geometry_resolution: 'standard', should_texture: true, enable_pbr: true,
  texture_resolution: '2k', texture_mode: 'source', texture_image_assets: [], should_remesh: true,
  topology: 'triangle', target_polycount: 50000, decimation_mode: null, save_pre_remeshed_model: false,
  pose_mode: '', image_enhancement: false, remove_lighting: true, moderation: false,
  target_formats: ['glb'], auto_size: false, origin_at: 'bottom', alpha_thumbnail: false, multi_view_thumbnails: false,
};
// Meshy targets match the wearable budget in production-v1 runtime.part_triangles,
// less the rear hair backing reserve, so fitting receives an already light mesh.
const partPolycount: Record<string, number> = {
  hair: 30000, hat: 8000, top: 18000, bottom: 12000, shoes: 8000, weapon: 8000, tool: 6000, glasses: 3000,
};
// One photo setting covers every part; the server lowers it to each part's budget.
export const sharedMeshyScope = 'photo-parts';
const sharedPolycount = 30000;
export const meshyBudgetFor = (scope: string) => scope === sharedMeshyScope ? sharedPolycount : partPolycount[scope] ?? defaultMeshyOptions.target_polycount;
export const meshyDefaultsFor = (scope: string): MeshyOptions =>
  ({ ...defaultMeshyOptions, target_polycount: meshyBudgetFor(scope) });
// v2: drafts saved under v1 kept unremeshed 2K geometry and produced multi-million-triangle parts.
const key = (scope: string) => `gaesup.meshy-7.1.v2:${scope}`;
export function useMeshyOptions(scope: string) {
  const initial = useMemo(() => {
    const defaults = meshyDefaultsFor(scope);
    try {
      const saved = { ...defaults, ...JSON.parse(localStorage.getItem(key(scope)) || '{}') } as MeshyOptions;
      if (!Number.isFinite(saved.target_polycount)) saved.target_polycount = defaults.target_polycount;
      if (!Array.isArray(saved.texture_image_assets)) saved.texture_image_assets = [];
      if (!Array.isArray(saved.target_formats)) saved.target_formats = ['glb'];
      if (!saved.target_formats.includes('glb')) saved.target_formats.unshift('glb');
      return saved;
    }
    catch { return defaults; }
  }, [scope]);
  const [drafts, setDrafts] = useState<Record<string, MeshyOptions>>({});
  const [storageError, setStorageError] = useState('');
  return { options: drafts[scope] || initial, storageError, setOptions: (value: MeshyOptions) => {
    setDrafts(current => ({ ...current, [scope]: value }));
    try { localStorage.setItem(key(scope), JSON.stringify(value)); setStorageError(''); }
    catch { setStorageError('Meshy 설정을 브라우저에 저장하지 못했습니다.'); }
  } };
}
export function meshyOptionsError(value: MeshyOptions) {
  if (value.should_remesh && value.decimation_mode === null
    && (!Number.isInteger(value.target_polycount) || value.target_polycount < 100 || value.target_polycount > 300000)) return '목표 폴리곤을 100~300,000 사이 정수로 입력하세요.';
  const count = value.texture_image_assets.length;
  if (value.should_texture && ((value.texture_mode === 'image' && count !== 1) || (value.texture_mode === 'images' && (count < 1 || count > 4)))) return '텍스처 참조 이미지를 선택하세요. 단일 1장 / 다중 1~4장.';
  return '';
}
