import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../../__tests__/mount';
import { factoryApi, nativeArtifact, wardrobePartSha, wardrobeUrls, type NativeDelivery, type NativePartsState, type NativeQuality, type WardrobePart } from '../factory/api';
import { NativeAssembly } from '../factory/NativeAssembly';
import { PipelineQuality } from '../factory/PipelineQuality';

const viewers = vi.hoisted(() => [] as { load: ReturnType<typeof vi.fn>; wear: ReturnType<typeof vi.fn> }[]);
vi.mock('../viewer', () => ({ ModelViewer: class {
  load = vi.fn(async () => []); play = vi.fn(); wear = vi.fn(async () => true); setHairColor = vi.fn(); dispose = vi.fn();
  constructor() { viewers.push(this); }
} }));
vi.mock('../../studio/usage', () => ({ usePaidWork: () => false }));
vi.mock('../studio/Expressions', () => ({ Expressions: ({ bodySha }: { bodySha: string }) => <p data-body-sha={bodySha} /> }));
vi.mock('../factory/NativePartRefit', () => ({ NativePartRefit: () => null }));
vi.mock('../factory/MeshyMotion', () => ({ MeshyMotion: () => null }));
vi.mock('../factory/RigRecovery', () => ({ RigRecovery: () => null }));

const receipt = (slot: string): NativeDelivery[string] => ({ artifact: `${slot}.runtime.glb`, sha256: `${slot}-runtime`,
  source_sha256: `${slot}-source`, source_bytes: 2 * 1024 * 1024, runtime_bytes: 1024 * 1024,
  method: 'lossless_buffer_compaction', geometry_preserved: true, uv_skin_animation_images_preserved: true });
const state = (): NativePartsState => ({ status: 'review_required', version: 'v1',
  parts: ['body', 'hair'].map(slot => ({ slot, objects: [slot], available: true })),
  artifacts: ['body', 'hair'].flatMap(slot => [
    { name: `${slot}.glb`, url: `/${slot}.glb`, sha256: `${slot}-source` },
    { name: `${slot}.runtime.glb`, url: `/${slot}.runtime.glb`, sha256: `${slot}-runtime` },
  ]), delivery: { body: receipt('body'), hair: receipt('hair') } });

describe('조립 산출물과 런타임 전달의 버전 연결', () => {
  it('기존 버전과 해시가 어긋난 전달 기록은 원본을 선택한다', () => {
    const value = state();
    expect(nativeArtifact(value, 'body')?.name).toBe('body.runtime.glb');
    delete value.delivery;
    expect(nativeArtifact(value, 'body')?.name).toBe('body.glb');
    value.delivery = { body: { ...receipt('body'), source_sha256: 'another-source' } };
    expect(nativeArtifact(value, 'body')?.name).toBe('body.glb');
    value.delivery.body = { ...receipt('body'), sha256: 'another-runtime' };
    expect(nativeArtifact(value, 'body')?.name).toBe('body.glb');
    value.delivery.body = { ...receipt('body'), geometry_preserved: false };
    expect(nativeArtifact(value, 'body')?.name).toBe('body.glb');
  });

  beforeEach(() => { vi.useFakeTimers(); viewers.length = 0; sessionStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); sessionStorage.clear(); });

  it('뷰어에는 런타임 해시를 주고 저장 조합과 표정에는 원본 몸 해시를 유지한다', async () => {
    vi.spyOn(factoryApi, 'nativeParts').mockResolvedValue(state());
    vi.spyOn(factoryApi, 'nativeOutfit').mockResolvedValue({ version: 'v1', body_sha256: 'body-source', revision: '0', slots: ['hair'] });
    const save = vi.spyOn(factoryApi, 'saveNativeOutfit').mockResolvedValue({ version: 'v1', body_sha256: 'body-source', revision: '1', slots: ['hair'] });
    const mounted = await mount(<NativeAssembly jobId="job" simple />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(viewers[0]!.load).toHaveBeenCalledWith('/body.runtime.glb', { sha256: 'body-runtime', wardrobe: true });
    expect(viewers[0]!.wear).toHaveBeenCalledWith([{ id: 'v1:hair', slot: 'hair', url: '/hair.runtime.glb', sha256: 'hair-runtime' }]);
    expect(mounted.container.querySelector('[data-body-sha]')?.getAttribute('data-body-sha')).toBe('body-source');
    const button = [...mounted.container.querySelectorAll('button')].find(item => item.textContent === '현재 조합 저장')!;
    await act(async () => { button.click(); await vi.advanceTimersByTimeAsync(10); });
    expect(save.mock.calls[0]![2]).toEqual({ body_sha256: 'body-source', slots: ['hair'], hair_color: null });
    await mounted.unmount();
  });
});

describe('옷장 전달 파일의 선택', () => {
  it('런타임 URL과 검증 해시는 같은 파일을 가리키며 파츠 원본 해시는 유지한다', () => {
    const part: WardrobePart = { job_id: 'job', version: 'v1', slot: 'hair', name: '헤어', sha256: 'source' };
    expect(wardrobeUrls.part(part)).toContain('/hair.glb');
    expect(wardrobePartSha(part)).toBe('source');
    part.runtime_name = 'hair.runtime.glb'; part.runtime_sha256 = 'runtime';
    expect(wardrobeUrls.part(part)).toContain('/hair.runtime.glb');
    expect(wardrobePartSha(part)).toBe('runtime');
    expect(part.sha256).toBe('source');
    part.runtime_name = '../other.glb';
    expect(wardrobeUrls.part(part)).toContain('/hair.glb');
    expect(wardrobePartSha(part)).toBe('source');
  });
});

describe('실제 조립 검수 수치', () => {
  it('후면 측정과 전달 수치를 표시하고 시각 검수는 별도 상태로 유지한다', async () => {
    const value = state();
    const quality: NativeQuality = { revision: 'assembly-quality-v1', status: 'review_required', visual_review: 'required',
      production_spec_sha256: 'spec', artifacts: {}, delivery: { model: receipt('model') }, checks: [], parts: {},
      rear_coverage: { rays: 85, covered: 71, ratio: .8353, geometric_ratio: .9 }, runtime: { triangles: 120000, texture_pixels: 4194304 } };
    value.quality = quality;
    const mounted = await mount(<PipelineQuality state={value} />);
    expect(mounted.container.textContent).toContain('83.5% · 71/85 지점');
    expect(mounted.container.textContent).toContain('90.0%');
    expect(mounted.container.textContent).toContain('120,000');
    expect(mounted.container.textContent).toContain('2.00 MB → 1.00 MB');
    expect(mounted.container.textContent).toContain('시각 검수 필요');
    await mounted.unmount();
  });

  it.each([['approved', '시각 승인 완료'], ['stale', '변경됨 · 재검수 필요']] as const)('sealed 품질은 유지하고 %s 시각 승인 기록을 표시한다', async (status, label) => {
    const value = state();
    value.quality = { revision: 'assembly-quality-v1', status: 'review_required', visual_review: 'required', production_spec_sha256: 'spec', artifacts: {}, delivery: {}, checks: [], parts: {}, runtime: {} };
    value.review = { status, reviewer_name: '검수자', reviewed_at: '2026-10-03T00:00:00Z', notes: '네 방향과 동작을 확인했습니다.' };
    const quality = JSON.stringify(value.quality);
    const mounted = await mount(<PipelineQuality state={value} />);
    expect(mounted.container.querySelector('summary')?.textContent).toContain(label);
    expect(mounted.container.textContent).toContain('검수자');
    expect(mounted.container.textContent).toContain(value.review.notes);
    expect(JSON.stringify(value.quality)).toBe(quality);
    await mounted.unmount();
  });
});
