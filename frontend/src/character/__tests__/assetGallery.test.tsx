import { act, useState } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PermissionName, User } from '../../api/types';
import { mount, type } from '../../__tests__/mount';
import { ApiError } from '../api';
import { factoryApi, type FactoryJob } from '../factory/api';
import Animals from '../studio/Animals';
import { AssetGallery } from '../studio/AssetGallery';
import { studioApi, type Catalog } from '../studio/api';
import Emoticons from '../studio/Emoticons';
import { ExpressionGenerationPanel } from '../studio/ExpressionGeneration';
import { expressionGenerationApi } from '../studio/expression-generation-api';
import Generations from '../studio/Generations';
import { generationsApi } from '../studio/generations-api';
import { Workspace } from '../studio/Workspace';
import { expressionNames } from '../texture-expressions';

const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: auth.user, status: 'signedIn' }) }));
vi.mock('../studio/AssetModelPreview', () => ({ AssetModelPreview: () => null }));
vi.mock('../studio/GlbAssetLibrary', () => ({ GlbAssetLibrary: () => null }));
const user = (...permissions: PermissionName[]): User => ({ id: 'u1', username: 'mogae', displayName: '모개', role: 'user', permissions });
const unavailable = () => new ApiError('studio_unavailable', '캐릭터 스튜디오가 응답하지 않습니다.', 503);
const catalog = { revision: '1', items: {}, parts: {} };

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const reload = async (container: Element) => {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent === '다시 불러오기');
  if (!found) throw new Error('no 다시 불러오기 button');
  await act(async () => found.click());
  await settle();
};

describe('목록을 처음 읽지 못하면', () => {
  let previous: string;
  beforeEach(() => {
    previous = `${location.pathname}${location.search}`;
    auth.user = user('operator', 'paid_operator');
    localStorage.clear();
    vi.spyOn(factoryApi, 'bodyProfile').mockResolvedValue({ revision: '1', body: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    history.replaceState(null, '', previous);
  });
  const library = async () => {
    // The studio page hands the workspace its screen in the query before it mounts (see StudioPage).
    history.replaceState(null, '', '/admin/studio/library?tab=admin');
    const mounted = await mount(<MemoryRouter><Workspace /></MemoryRouter>);
    await settle();
    return { ...mounted, gallery: mounted.container.querySelector('.asset-gallery')! };
  };

  it('라이브러리는 관리 목록을 계속 불러오는 중이라 하지 않고, 실패와 다시 불러오기를 보인다', async () => {
    vi.spyOn(factoryApi, 'list').mockResolvedValue({ jobs: [] });
    const read = vi.spyOn(studioApi, 'catalog').mockRejectedValueOnce(unavailable()).mockResolvedValue(catalog);
    const { gallery, unmount } = await library();
    expect(gallery.textContent).toContain('목록을 불러오지 못했습니다.');
    expect(gallery.textContent).not.toContain('관리 목록 불러오는 중…');
    await reload(gallery);
    expect(read).toHaveBeenCalledTimes(2);
    expect(gallery.textContent).not.toContain('목록을 불러오지 못했습니다.');
    expect(gallery.textContent).toContain('이 분류에 저장된 파츠가 없습니다.');
    await unmount();
  });

  it('라이브러리는 작업 목록을 읽지 못한 것을 저장된 파츠가 없다고 하지 않는다', async () => {
    const read = vi.spyOn(factoryApi, 'list').mockRejectedValueOnce(unavailable()).mockResolvedValue({ jobs: [] });
    vi.spyOn(studioApi, 'catalog').mockResolvedValue(catalog);
    const { gallery, unmount } = await library();
    expect(gallery.textContent).toContain('목록을 불러오지 못했습니다.');
    expect(gallery.textContent).not.toContain('이 분류에 저장된 파츠가 없습니다.');
    await reload(gallery);
    expect(read).toHaveBeenCalledTimes(2);
    expect(gallery.textContent).toContain('이 분류에 저장된 파츠가 없습니다.');
    await unmount();
  });

  it('동물 화면은 저장된 동물이 없다고 하지 않는다', async () => {
    const read = vi.spyOn(studioApi, 'animals').mockRejectedValueOnce(unavailable()).mockResolvedValue({ items: [] });
    const { container, unmount } = await mount(<Animals />);
    await settle();
    expect(container.textContent).toContain('목록을 불러오지 못했습니다.');
    expect(container.textContent).not.toContain('저장된 동물이 없습니다.');
    await reload(container);
    expect(read).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('저장된 동물이 없습니다.');
    await unmount();
  });

  it('기물 화면은 저장된 결과가 없다고 하지 않는다', async () => {
    const read = vi.spyOn(generationsApi, 'list').mockRejectedValueOnce(unavailable()).mockResolvedValue({ items: [], capabilities: { ready: true }, defaults: {} });
    const { container, unmount } = await mount(<Generations />);
    await settle();
    expect(container.textContent).toContain('목록을 불러오지 못했습니다.');
    expect(container.textContent).not.toContain('저장된 결과가 없습니다.');
    await reload(container);
    expect(read).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('저장된 결과가 없습니다.');
    await unmount();
  });

  it('2D 원화 갤러리는 저장된 원화가 없다고 하지 않는다', async () => {
    const read = vi.spyOn(generationsApi, 'list').mockRejectedValueOnce(unavailable()).mockResolvedValue({ items: [], capabilities: { ready: true }, defaults: {} });
    vi.spyOn(generationsApi, 'illustrationSelection').mockResolvedValue({ selected: null, revision: '1' });
    const { container, unmount } = await mount(<Emoticons />);
    await settle();
    expect(container.textContent).toContain('목록을 불러오지 못했습니다.');
    expect(container.textContent).not.toContain('저장된 원화 없음');
    await reload(container);
    expect(read).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('저장된 원화 없음');
    await unmount();
  });

  it('표정 텍스처 목록은 생성한 텍스처가 없다고 하지 않는다', async () => {
    const read = vi.spyOn(expressionGenerationApi, 'list').mockRejectedValueOnce(unavailable()).mockResolvedValue({
      items: [], batches: [], capabilities: { ready: true, reason: null }, reference: { revision: '1', assets: [] },
      defaults: Object.fromEntries(Object.keys(expressionNames).map(name => [name, name])) as Record<keyof typeof expressionNames, string>,
    });
    const { container, unmount } = await mount(<ExpressionGenerationPanel job="job-1" version="v1" ready onApply={async () => {}} />);
    await settle();
    expect(container.textContent).toContain('목록을 불러오지 못했습니다.');
    expect(container.textContent).not.toContain('생성한 표정 텍스처가 없습니다.');
    await reload(container);
    expect(read).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('생성한 표정 텍스처가 없습니다.');
    await unmount();
  });

  it('성공한 빈 목록은 그대로 빈 목록이라 한다', async () => {
    vi.spyOn(studioApi, 'animals').mockResolvedValue({ items: [] });
    vi.spyOn(generationsApi, 'list').mockResolvedValue({ items: [], capabilities: { ready: true }, defaults: {} });
    for (const [screen, empty] of [[<Animals />, '저장된 동물이 없습니다.'], [<Generations />, '저장된 결과가 없습니다.']] as const) {
      const { container, unmount } = await mount(screen);
      await settle();
      expect(container.textContent).toContain(empty);
      expect(container.textContent).not.toContain('목록을 불러오지 못했습니다.');
      await unmount();
    }
  });
});

const hair = (id: string, name: string): FactoryJob => ({
  id, character_id: 'mogae', character_name: '모개', source_sha256: 'a'.repeat(64), status: 'complete',
  created_at: '2026-10-01T00:00:00Z', base_job_id: 'base', requested_slots: ['hair'], part_name: name,
  progress: { stage: 'complete', message: '' }, artifacts: [{ name: 'hair-front.png', url: `/files/${id}/hair-front.png` }],
});
const jobs = [hair('h1', '단발'), hair('h2', '장발'), hair('h3', '숏컷'), hair('h4', '포니테일')];

/** The character server's list: a change sent on an older revision is refused, and each saved one moves it on. */
let stored: Catalog, writes = 0;
/** What another screen changes on the server just as a part's change arrives. */
let arriving: (key: string) => void;
/** Changes the server saves but whose answer never comes back. */
const lost = new Set<string>();

function Library({ catalog: initial }: { catalog?: Catalog }) {
  const [catalog, setCatalog] = useState(initial);
  return <AssetGallery jobs={jobs} catalog={catalog} onOpen={() => {}} onCompose={() => {}} onCatalogChange={setCatalog} onRefresh={async () => {}} />;
}

/** Clicks as a person does, then lets the requests it started answer. */
const press = (element: HTMLElement | null | undefined) => act(async () => {
  element!.click();
  await new Promise((done) => setTimeout(done, 0));
});
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.startsWith(text));
const box = (container: HTMLElement, name: string) => container.querySelector<HTMLInputElement>(`input[type=checkbox][aria-label="${name} 선택"]`);
const names = (container: HTMLElement) => [...container.querySelectorAll('.asset-gallery-info strong')].map((item) => item.textContent);
const ticked = (container: HTMLElement) => [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
  .filter((item) => item.checked).map((item) => item.getAttribute('aria-label'));
const open = async () => {
  const mounted = await mount(<Library catalog={stored} />);
  await press(button(mounted.container, '헤어'));
  return mounted;
};

describe('에셋 라이브러리에서 파츠 여러 개 옮기기', () => {
  beforeEach(() => {
    stored = { revision: 'r0', items: {}, parts: {} };
    writes = 0;
    arriving = () => {};
    lost.clear();
    vi.spyOn(studioApi, 'catalog').mockImplementation(async () => stored);
    vi.spyOn(studioApi, 'savePartMetadata').mockImplementation(async (id, slot, changes, revision) => {
      const key = `${id}:${slot}`;
      arriving(key);
      if (revision !== stored.revision) throw new ApiError('revision_conflict', '관리 목록이 변경되었습니다. 다시 불러오세요.', 409);
      stored = { ...stored, revision: `r${++writes}`, parts: { ...stored.parts, [key]: { ...stored.parts[key], ...changes } } };
      if (lost.has(key)) throw new ApiError('timeout', '서버 응답이 늦어지고 있습니다. 잠시 후 다시 시도해 주세요.', 0);
      return stored;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('고른 헤어를 한 번에 휴지통으로 옮기면 갤러리에서 빠지고 휴지통에 보인다', async () => {
    const { container, unmount } = await open();
    expect(names(container)).toEqual(['단발', '장발', '숏컷', '포니테일']);
    expect(button(container, '선택 삭제')?.disabled).toBe(true);
    for (const name of ['단발', '숏컷', '포니테일']) await press(box(container, name));
    expect(container.querySelector('.asset-gallery-selection span')?.textContent).toBe('3개 선택');

    await press(button(container, '선택 삭제'));
    // One after another, each sent on the list the one before it left.
    expect(vi.mocked(studioApi.savePartMetadata).mock.calls).toEqual([
      ['h1', 'hair', { deleted: true }, 'r0'], ['h3', 'hair', { deleted: true }, 'r1'], ['h4', 'hair', { deleted: true }, 'r2'],
    ]);
    expect(names(container)).toEqual(['장발']);
    expect(container.querySelector('[role=status]')?.textContent).toBe('3개를 휴지통으로 이동했습니다.');
    expect(container.querySelector('[role=alert]')).toBeNull();

    await press(button(container, '휴지통'));
    expect(names(container)).toEqual(['단발', '숏컷', '포니테일']);
    expect(ticked(container)).toEqual([]);
    await unmount();
  });

  it('옮기지 못한 파츠는 이유와 함께 알리고 선택된 채로 남기며, 나머지는 이어서 옮긴다', async () => {
    arriving = (key) => {
      // Another screen renamed a part just before 장발's change arrived, which was sent on the list before that.
      if (key === 'h2:hair') stored = { ...stored, revision: 'elsewhere', parts: { ...stored.parts, 'h4:hair': { name: '포니테일 2' } } };
    };
    lost.add('h3:hair');
    const { container, unmount } = await open();
    for (const name of ['단발', '장발', '숏컷']) await press(box(container, name));
    await press(button(container, '선택 삭제'));

    // The rest went on the list read again after the refusal.
    expect(vi.mocked(studioApi.savePartMetadata).mock.calls.map((call) => [call[0], call[3]])).toEqual([['h1', 'r0'], ['h2', 'r1'], ['h3', 'elsewhere']]);
    // 숏컷 was saved though its answer was lost: the list read again has it in the trash.
    expect(names(container)).toEqual(['장발', '포니테일 2']);
    expect(container.querySelector('[role=alert]')?.textContent).toBe('삭제 실패 1개 · 장발: 관리 목록이 변경되었습니다. 다시 불러오세요.');
    expect(container.querySelector('[role=status]')?.textContent).toBe('2개를 휴지통으로 이동했습니다.');
    expect(ticked(container)).toEqual(['장발 선택']);

    arriving = () => {};
    await press(button(container, '선택 삭제'));
    expect(names(container)).toEqual(['포니테일 2']);
    expect(container.querySelector('[role=alert]')).toBeNull();
    expect(ticked(container)).toEqual([]);
    await unmount();
  });

  it('보이는 것만 옮기고, 검색에 가려진 선택은 그대로 남긴다', async () => {
    const { container, unmount } = await open();
    await press(box(container, '장발'));
    const search = container.querySelector<HTMLInputElement>('input[type=search]')!;
    await type(search, '숏');
    expect(names(container)).toEqual(['숏컷']);
    await press(button(container, '전체 선택'));
    expect(ticked(container)).toEqual(['숏컷 선택']);
    expect(container.querySelector('.asset-gallery-selection span')?.textContent).toBe('1개 선택');

    await press(button(container, '선택 삭제'));
    expect(vi.mocked(studioApi.savePartMetadata).mock.calls.map((call) => call[0])).toEqual(['h3']);
    await type(search, '');
    expect(names(container)).toEqual(['단발', '장발', '포니테일']);
    expect(ticked(container)).toEqual(['장발 선택']);
    await unmount();
  });

  it('휴지통에서 여러 개를 골라 한 번에 복원한다', async () => {
    stored = { revision: 'r0', items: {}, parts: { 'h1:hair': { deleted: true }, 'h2:hair': { deleted: true }, 'h3:hair': { deleted: true } } };
    const { container, unmount } = await open();
    expect(names(container)).toEqual(['포니테일']);
    await press(button(container, '휴지통'));
    expect(names(container)).toEqual(['단발', '장발', '숏컷']);
    await press(button(container, '전체 선택'));
    expect(ticked(container)).toEqual(['단발 선택', '장발 선택', '숏컷 선택']);
    await press(button(container, '전체 해제'));
    expect(ticked(container)).toEqual([]);
    await press(button(container, '전체 선택'));
    await press(box(container, '장발'));
    expect(container.querySelector('.asset-gallery-selection span')?.textContent).toBe('2개 선택');

    await press(button(container, '선택 복원'));
    expect(vi.mocked(studioApi.savePartMetadata).mock.calls).toEqual([
      ['h1', 'hair', { deleted: false }, 'r0'], ['h3', 'hair', { deleted: false }, 'r1'],
    ]);
    expect(names(container)).toEqual(['장발']);
    expect(container.querySelector('[role=status]')?.textContent).toBe('2개를 복원했습니다.');
    await press(button(container, '갤러리'));
    expect(names(container)).toEqual(['단발', '숏컷', '포니테일']);
    await unmount();
  });

  it('카드 하나의 삭제는 그대로 취소할 수 있고, 여러 개를 옮기면 그 전 삭제의 취소가 남지 않는다', async () => {
    const { container, unmount } = await open();
    await press(container.querySelector<HTMLButtonElement>('button[aria-label="단발 삭제"]'));
    expect(container.querySelector('[role=status] span')?.textContent).toBe('휴지통으로 이동했습니다.');
    await press(button(container, '삭제 취소'));
    expect(names(container)).toEqual(['단발', '장발', '숏컷', '포니테일']);

    await press(container.querySelector<HTMLButtonElement>('button[aria-label="단발 삭제"]'));
    for (const name of ['장발', '숏컷']) await press(box(container, name));
    await press(button(container, '선택 삭제'));
    expect(names(container)).toEqual(['포니테일']);
    expect(container.querySelector('[role=status]')?.textContent).toBe('2개를 휴지통으로 이동했습니다.');
    expect(button(container, '삭제 취소')).toBeUndefined();
    await unmount();
  });

  it('관리 목록이 없으면 삭제 버튼처럼 고르고 옮기는 기능도 없다', async () => {
    const { container, unmount } = await mount(<Library />);
    await press(button(container, '헤어'));
    expect(container.querySelector('input[type=checkbox]')).toBeNull();
    expect(button(container, '선택 삭제')).toBeUndefined();
    expect(studioApi.savePartMetadata).not.toHaveBeenCalled();
    await unmount();
  });
});
