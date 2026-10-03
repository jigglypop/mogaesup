import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { mount } from '../../__tests__/mount';
import { factoryApi, type FactoryJob, type NativePartsState } from '../factory/api';
import { studioApi } from '../studio/api';
import { SinglePart } from '../studio/SinglePart';

// The screens beside the form (the viewer, progress, stage runner, uploads) are not what is tested.
vi.mock('../factory/NativeAssembly', () => ({ NativeAssembly: () => null }));
vi.mock('../factory/PartProgress', () => ({ PartProgress: () => null }));
vi.mock('../factory/ProductionProgress', () => ({ ProductionProgress: () => null }));
vi.mock('../factory/StageRunner', () => ({ StageRunner: () => null }));
vi.mock('../studio/HairBatch', () => ({ HairBatch: () => null }));
vi.mock('../studio/GlbAssetLibrary', () => ({ GlbAssetLibrary: () => null }));
vi.mock('../studio/MeshyOptionsEditor', () => ({ MeshyOptionsEditor: () => null }));
vi.mock('../studio/AssetModelPreview', () => ({ AssetModelPreview: ({ model }: { model?: { url: string; sha256: string; label: string } }) => <div data-reference-model={JSON.stringify(model)} /> }));
vi.mock('../studio/garment-styles.json', async importOriginal => {
  const original = await importOriginal<{ default: { style: string; garments: { name: string }[] } }>();
  return { default: { ...original.default, garments: original.default.garments.map(item => item.name === '오트밀 유틸리티 블루종' ? { ...item, model: { url: '/character/references/oatmeal-utility-blouson.glb', sha256: 'a'.repeat(64) } } : item) } };
});

const base = { id: 'base-job', character_name: '모개', created_at: '2026-09-30T00:00:00Z', artifacts: [] } as unknown as FactoryJob;
const native = { status: 'review_required', version: 'v1', artifacts: [], parts: [] } as unknown as NativePartsState;

const settle = () =>
  act(async () => {
    await Promise.resolve();
  });
const select = (container: HTMLElement, label: string) => {
  const found = [...container.querySelectorAll('label')].find((item) => item.firstChild?.textContent === label)?.querySelector('select');
  if (!found) throw new Error(`no ${label} select`);
  return found;
};
const choose = (container: HTMLElement, label: string, value: string) =>
  act(async () => {
    const target = select(container, label);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(target, value);
    target.dispatchEvent(new Event('change', { bubbles: true }));
  });
const labels = (container: HTMLElement) => [...container.querySelectorAll('label')].map((item) => item.firstChild?.textContent);

describe('파츠 하나 만들기', () => {
  let singlePart: MockInstance<typeof studioApi.singlePart>;
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(factoryApi, 'capabilities').mockResolvedValue({ model_providers: ['meshy'], default_model_provider: 'meshy' } as never);
    singlePart = vi.spyOn(studioApi, 'singlePart').mockResolvedValue({ id: 'new-job' } as FactoryJob);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const open = (slot: 'top' | 'bottom') =>
    mount(
      <SinglePart
        slot={slot}
        onSlotChange={() => {}}
        bases={[base]}
        base={base}
        native={native}
        versions={[base]}
        name={() => '모개'}
        onBaseChange={() => {}}
        onJobChange={() => {}}
        onJob={() => {}}
        refreshJobs={async () => {}}
      />,
    );
  const submit = (container: HTMLElement, label: string) => act(async () => [...container.querySelectorAll('button')].find((item) => item.textContent === label)!.click());

  it('상의의 소매와 여유는 단독 3D 생성을 고를 때만 묻는다', async () => {
    const { container, unmount } = await open('top');
    await settle();
    expect(labels(container)).not.toContain('소매');
    expect(labels(container)).not.toContain('여유');

    await choose(container, '만드는 방식', 'isolated');
    expect(labels(container)).toContain('소매');
    expect(labels(container)).toContain('여유');

    await choose(container, '만드는 방식', 'body_shell');
    expect(labels(container)).not.toContain('소매');
    expect(labels(container)).not.toContain('여유');
    await unmount();
  });

  it('하의는 어느 방식에서나 종류를 묻고, 여유는 단독 3D 생성에서만 묻는다', async () => {
    const { container, unmount } = await open('bottom');
    await settle();
    expect(labels(container)).toContain('하의 종류');
    expect(labels(container)).not.toContain('여유');
    await choose(container, '만드는 방식', 'isolated');
    expect(labels(container)).toContain('하의 종류');
    expect(labels(container)).toContain('여유');
    await unmount();
  });

  it('입힌 채 만들 때는 보내는 요청에 소매와 여유가 기본값으로만 실린다', async () => {
    const { container, unmount } = await open('top');
    await settle();
    await submit(container, '상의 하나 생성');
    expect(singlePart).toHaveBeenCalledTimes(1);
    expect(singlePart.mock.calls[0]?.[0]).toMatchObject({
      slot: 'top',
      part_method: 'worn',
      fit_profile: { revision: 'garment-fit-v1', sleeve: 'source', ease: 'source' },
    });
    await unmount();
  });

  it('단독 3D 생성에서 고른 소매와 여유는 보내고, 다른 방식으로 바꾸면 기본값으로 돌아간다', async () => {
    const { container, unmount } = await open('top');
    await settle();
    await choose(container, '만드는 방식', 'isolated');
    await choose(container, '소매', 'long');
    await choose(container, '여유', 'loose');
    await submit(container, '상의 하나 생성');
    expect(singlePart.mock.calls[0]?.[0]).toMatchObject({
      part_method: 'isolated',
      fit_profile: { sleeve: 'long', ease: 'loose' },
    });
    // 저장된 요청을 비워 다음 요청을 새로 보낸다.
    localStorage.clear();

    // 다른 방식으로 갔다 오면 골랐던 값은 기본값으로 돌아가 있다.
    await choose(container, '만드는 방식', 'worn');
    await choose(container, '만드는 방식', 'isolated');
    expect(select(container, '소매').value).toBe('source');
    expect(select(container, '여유').value).toBe('source');
    await choose(container, '만드는 방식', 'worn');
    await submit(container, '상의 하나 생성');
    expect(singlePart.mock.calls[1]?.[0]).toMatchObject({ part_method: 'worn', fit_profile: { sleeve: 'source', ease: 'source' } });
    await unmount();
  });

  it('하의 종류는 입힌 채 만들어도 보낸다', async () => {
    const { container, unmount } = await open('bottom');
    await settle();
    await choose(container, '하의 종류', 'skirt');
    await submit(container, '하의 하나 생성');
    expect(singlePart.mock.calls[0]?.[0]).toMatchObject({
      slot: 'bottom',
      bottom_kind: 'skirt',
      fit_profile: { revision: 'garment-fit-v1', kind: 'skirt', ease: 'source' },
    });
    await unmount();
  });

  it('생성된 블루종 참조를 미리 보고 기존 업로드 API를 통해 텍스처 요청에 전달한다', async () => {
    const reference = '/character/references/oatmeal-utility-blouson.png';
    const image = new Blob(['reference pixels'], { type: 'image/png' });
    const fetchMock = vi.fn<typeof fetch>(async url => {
      if (url === reference) return { ok: true, blob: async () => image } as Response;
      if (url === '/api/avatar-factory/meshy-options/texture-assets') return new Response(JSON.stringify({ id: 'blouson-reference-asset' }), { status: 201 });
      throw new Error(`unexpected request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container, unmount } = await open('top');
    await settle();
    await choose(container, '스타일', '오트밀 유틸리티 블루종');
    expect(container.querySelector('img[alt="오트밀 유틸리티 블루종 참조 그림"]')?.getAttribute('src')).toBe(reference);
    expect(JSON.parse(container.querySelector('[data-reference-model]')!.getAttribute('data-reference-model')!)).toEqual({ url: '/character/references/oatmeal-utility-blouson.glb', sha256: 'a'.repeat(64), label: '3D 참조' });
    await submit(container, '텍스처 참조로 사용');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toEqual(['/api/avatar-factory/meshy-options/texture-assets', expect.objectContaining({ method: 'POST', body: expect.any(Blob), headers: { 'Content-Type': 'image/png' } })]);
    expect(singlePart).not.toHaveBeenCalled();
    await submit(container, '상의 하나 생성');
    expect(singlePart.mock.calls[0]![0]).toMatchObject({ part_name: '오트밀 유틸리티 블루종', meshy_options: { should_texture: true, texture_mode: 'image', texture_image_assets: ['blouson-reference-asset'] } });
    await unmount();
  });
});
