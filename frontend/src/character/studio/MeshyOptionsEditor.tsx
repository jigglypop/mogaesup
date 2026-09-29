import { useEffect, useRef, useState } from 'react';
import { request } from '../api';
import { meshyBudgetFor, sharedMeshyScope, type MeshyOptions } from './meshy-options';
import './meshy-options.css';

type Props = { value: MeshyOptions; scope: string; disabled?: boolean; onChange: (value: MeshyOptions) => void; onUploading: (value: boolean) => void };
export function MeshyOptionsEditor({ value, scope, disabled, onChange, onUploading }: Props) {
  const budget = meshyBudgetFor(scope);
  const budgetLabel = scope === sharedMeshyScope ? '파츠별 면 수' : `${budget.toLocaleString()} 면`;
  const [uploading, setUploading] = useState(false), [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); onUploading(false); }, [onUploading]);
  const locked = disabled || uploading;
  const update = (change: Partial<MeshyOptions>) => onChange({ ...value, ...change });
  const check = (field: keyof MeshyOptions, label: string, inactive = false) => <label className="meshy-option-check"><input type="checkbox" checked={value[field] === true} disabled={locked || inactive} onChange={event => update({ [field]: event.target.checked })} />{label}</label>;
  async function upload(files: File[]) {
    if (uploading || !files.length) return;
    const limit = value.texture_mode === 'image' ? 1 : 4;
    if (value.texture_image_assets.length + files.length > limit) { setError(`참조 이미지는 최대 ${limit}장입니다.`); return; }
    if (files.some(file => !['image/png', 'image/jpeg'].includes(file.type) || file.size > 32*1024*1024)) { setError('32MB 이하 PNG/JPEG를 선택하세요.'); return; }
    controller.current = new AbortController(); const signal = controller.current.signal;
    setUploading(true); onUploading(true); setError('');
    try {
      const assets = await Promise.all(files.map(file => request<{ id: string }>('/api/avatar-factory/meshy-options/texture-assets', {
        method: 'POST', body: file, headers: { 'Content-Type': file.type }, signal, timeoutMs: 60000,
      })));
      if (!signal.aborted) update({ texture_image_assets: [...value.texture_image_assets, ...assets.map(asset => asset.id)] });
    } catch (reason) { if (!signal.aborted) setError((reason as Error).message); }
    finally { if (!signal.aborted) { setUploading(false); onUploading(false); } }
  }
  const light = value.geometry_resolution === 'standard' && value.should_remesh && value.target_polycount === budget && value.decimation_mode === null && value.texture_resolution === '2k';
  const high = value.geometry_resolution === '2k' && !value.should_remesh && value.texture_resolution === '4k';
  return <div className="meshy-generation-settings"><div className="meshy-presets" role="group" aria-label="3D 출력 설정">
    <button type="button" disabled={locked} aria-pressed={light} onClick={() => update({geometry_resolution:'standard', should_remesh:true, target_polycount:budget, decimation_mode:null, texture_resolution:'2k'})}>가벼운 출력<small>Standard · {budgetLabel} · 2K</small></button>
    <button type="button" disabled={locked} aria-pressed={high} onClick={() => update({geometry_resolution:'2k', should_remesh:false, texture_resolution:'4k'})}>고해상도 출력<small>Ultra · 원본 면 · 4K</small></button>
  </div><details className="meshy-generation-options">
    <summary>세부 설정 · {value.geometry_resolution === '2k' ? 'Ultra 2K' : 'Standard'} · {value.should_remesh ? value.decimation_mode ? `자동 폴리곤 ${value.decimation_mode}` : Number.isFinite(value.target_polycount) ? `${value.target_polycount.toLocaleString()} 면` : '폴리곤 입력 필요' : '원본 면'}</summary>
    <fieldset disabled={locked}><legend>메시</legend><div className="meshy-option-grid">
      <label>형상 해상도<select value={value.geometry_resolution} onChange={event => update({ geometry_resolution: event.target.value as MeshyOptions['geometry_resolution'] })}><option value="standard">Standard</option><option value="2k">Ultra 2K</option></select></label>
      <label>자세<select value={value.pose_mode} onChange={event => update({ pose_mode: event.target.value as MeshyOptions['pose_mode'] })}><option value="">원본 자세</option><option value="t-pose">T 포즈</option><option value="a-pose">A 포즈</option></select></label>
    </div>{check('should_remesh', '리메시')}
    <div className="meshy-option-grid">
      <label>면 구성<select disabled={!value.should_remesh} value={value.topology} onChange={event => update({ topology: event.target.value as MeshyOptions['topology'] })}><option value="triangle">삼각형</option><option value="quad">사각형 중심</option></select></label>
      <label>폴리곤 결정<select disabled={!value.should_remesh} value={value.decimation_mode ?? ''} onChange={event => update({ decimation_mode: event.target.value ? Number(event.target.value) as 1 | 2 | 3 | 4 : null })}><option value="">직접 입력</option><option value="1">자동 · Ultra</option><option value="2">자동 · High</option><option value="3">자동 · Medium</option><option value="4">자동 · Low</option></select></label>
      <label>목표 폴리곤<input type="number" min={100} max={300000} step={1} disabled={!value.should_remesh || value.decimation_mode !== null} value={Number.isFinite(value.target_polycount) ? value.target_polycount : ''} onChange={event => update({ target_polycount: event.target.valueAsNumber })} /></label>
    </div>{check('save_pre_remeshed_model', '리메시 전 GLB도 저장', !value.should_remesh)}
    <small>목표 100~300,000 · 자동 단계 선택 시 목표 수는 사용하지 않습니다.</small></fieldset>
    <fieldset disabled={locked}><legend>텍스처</legend>{check('should_texture', '텍스처 생성')}
      <div className="meshy-option-grid"><label>해상도<select disabled={!value.should_texture} value={value.texture_resolution} onChange={event => update({ texture_resolution: event.target.value as MeshyOptions['texture_resolution'] })}>{['2k','4k','8k'].map(item => <option key={item} value={item}>{item.toUpperCase()}</option>)}</select></label>
      <label>텍스처 기준<select disabled={!value.should_texture} value={value.texture_mode} onChange={event => update({ texture_mode: event.target.value as MeshyOptions['texture_mode'], texture_image_assets: event.target.value === 'image' ? value.texture_image_assets.slice(0,1) : value.texture_image_assets })}><option value="source">파츠 원화</option><option value="prompt">프롬프트 관리 문장</option><option value="image">참조 이미지 1장</option><option value="images">참조 이미지 1~4장</option></select></label></div>
      {check('enable_pbr', 'PBR 맵', !value.should_texture)}{check('remove_lighting', '텍스처 명암 제거', !value.should_texture)}
      {value.should_texture && value.texture_mode === 'prompt' && <a href="/?tab=prompts&promptGroup=meshy_texture" target="_blank" rel="noreferrer">3D 텍스처 프롬프트 관리</a>}
      {value.should_texture && ['image','images'].includes(value.texture_mode) && <div className="meshy-texture-inputs">
        <label>{uploading ? '이미지 등록 중' : 'PNG/JPEG 참조'}<input type="file" accept="image/png,image/jpeg" multiple={value.texture_mode === 'images'} onChange={event => { void upload([...event.target.files || []]); event.target.value = ''; }} /></label>
        {value.texture_image_assets.map((asset,index) => <div key={`${asset}:${index}`}><img src={`/api/avatar-blueprints/assets/${asset}`} alt={`텍스처 참조 ${index+1}`} /><span>{index === 0 ? '1 · 정면' : index+1}</span><button type="button" onClick={() => update({ texture_image_assets: value.texture_image_assets.filter((_,i) => i!==index) })}>제거</button></div>)}
      </div>}
    </fieldset>
    <fieldset disabled={locked}><legend>입력·크기</legend>{check('image_enhancement', '입력 이미지 자동 보정')}{check('moderation', '입력 콘텐츠 검사')}{check('auto_size', 'AI 크기 추정')}
      <label>원점<select disabled={!value.auto_size} value={value.origin_at} onChange={event => update({ origin_at: event.target.value as MeshyOptions['origin_at'] })}><option value="bottom">바닥</option><option value="center">중심</option></select></label>
      <small>생성 원본에 적용됩니다. 착용 파츠는 기준 몸에 맞춰 피팅합니다.</small>
    </fieldset>
    <fieldset disabled={locked}><legend>출력</legend><div className="meshy-option-formats">{(['glb','obj','fbx','stl','usdz','3mf'] as const).map(format => <label className="meshy-option-check" key={format}><input type="checkbox" disabled={format === 'glb'} checked={value.target_formats.includes(format)} onChange={event => update({ target_formats: event.target.checked ? [...value.target_formats,format] : value.target_formats.filter(item => item !== format) })} />{format.toUpperCase()}{format === 'glb' ? ' · 조립 필수' : ''}</label>)}</div>
      {check('alpha_thumbnail', '투명 배경 미리보기')}{check('multi_view_thumbnails', '앞·오른쪽·뒤·왼쪽 미리보기')}
    </fieldset>
    {error && <p role="alert">{error}</p>}
  </details></div>;
}
