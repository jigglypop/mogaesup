import { act, useState } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount, type } from '../../__tests__/mount';
import type { FactoryJob } from '../factory/api';
import { AssetGallery } from '../studio/AssetGallery';
import { studioApi, type Catalog } from '../studio/api';

// The card's 3D preview is not what is tested.
vi.mock('../studio/AssetModelPreview', () => ({ AssetModelPreview: () => null }));

const job = (id: string, name: string) => ({
  id, character_id: id, character_name: name, source_sha256: 'a', status: 'complete', created_at: '2026-09-01T00:00:00Z',
  progress: { stage: 'complete', message: '' }, artifacts: [{ name: 'body-front.png', url: `/${id}.png` }],
}) as FactoryJob;
const jobs = [job('job-a', '가'), job('job-b', '나')];

/** The gallery with the catalog it changes, as the workspace keeps it. */
function Gallery() {
  const [catalog, setCatalog] = useState<Catalog>({ revision: 'r0', items: {}, parts: {} });
  return <AssetGallery jobs={jobs} catalog={catalog} onCatalogChange={setCatalog} onRefresh={async () => {}} onOpen={() => {}} onCompose={() => {}} />;
}
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === text);

describe('저장된 에셋의 알림', () => {
  beforeEach(() => {
    const parts: Catalog['parts'] = {};
    let revision = 0;
    vi.spyOn(studioApi, 'savePartMetadata').mockImplementation(async (id, slot, changes) => {
      parts[`${id}:${slot}`] = { ...parts[`${id}:${slot}`], ...changes };
      return { revision: `r${++revision}`, items: {}, parts: { ...parts } };
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('다른 파츠를 지운 뒤 이름을 저장하면 그 알림에는 삭제 취소가 없다', async () => {
    const { container, unmount } = await mount(<Gallery />);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="가 · 기본 몸 삭제"]')!.click());
    expect(container.querySelector('.asset-delete-notice')?.textContent).toBe('휴지통으로 이동했습니다.삭제 취소');

    await act(async () => button(container, '이름 수정')!.click());
    await type(container.querySelector<HTMLInputElement>('.asset-gallery-edit input')!, '나의 몸');
    await act(async () => button(container, '저장')!.click());
    expect(studioApi.savePartMetadata).toHaveBeenLastCalledWith('job-b', 'body', { name: '나의 몸' }, 'r1');
    expect(container.querySelector('.asset-delete-notice')?.textContent).toBe('이름을 저장했습니다.');
    expect(button(container, '삭제 취소')).toBeUndefined();
    await unmount();
  });
});
