import { act, type ReactNode } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PermissionName, User } from '../../api/types';
import { mount, type } from '../../__tests__/mount';
import { factoryApi } from '../factory/api';
import Animals from '../studio/Animals';
import { studioApi } from '../studio/api';
import BaseBodies from '../studio/BaseBodies';
import Emoticons from '../studio/Emoticons';
import { ExpressionGenerationPanel } from '../studio/ExpressionGeneration';
import { expressionGenerationApi } from '../studio/expression-generation-api';
import { generationsApi } from '../studio/generations-api';
import { GlbAssetLibrary } from '../studio/GlbAssetLibrary';
import { glbAssetsApi } from '../studio/glb-assets-api';
import { GlbBodyForm } from '../studio/GlbBodyForm';

const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: auth.user, status: 'signedIn' }) }));
// The panels beside the request forms are not what is tested.
vi.mock('../factory/MeshyMotion', () => ({ MeshyMotion: () => null }));
vi.mock('../factory/NativeAssembly', () => ({ NativeAssembly: () => null }));
vi.mock('../factory/ProductionProgress', () => ({ ProductionProgress: () => null }));
vi.mock('../factory/StageRunner', () => ({ StageRunner: () => null }));
vi.mock('../studio/WardrobeBodies', () => ({ WardrobeBodies: () => null }));
vi.mock('../studio/AssetModelPreview', () => ({ AssetModelPreview: () => null }));
vi.mock('../studio/AssetDetailDialog', () => ({ AssetDetailDialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

const user = (...permissions: PermissionName[]): User => ({ id: 'u1', username: 'mogae', displayName: '모개', role: 'user', permissions });
const hash = (letter: string) => letter.repeat(64);
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const settle = () =>
  act(async () => {
    for (let round = 0; round < 3; round++) await new Promise((done) => setTimeout(done, 0));
  });
const click = (container: HTMLElement, label: string) => act(async () => {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent === label);
  if (!found) throw new Error(`no ${label} button`);
  found.click();
});

// Each screen read its saved request when it last rendered; another tab then got the answer and forgot it. Resuming from
// that screen sends the same key, so the server answers with what the key already made instead of making it again.
describe('다른 탭이 이미 복구해 지운 유료 요청', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const sentKey = () => new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Idempotency-Key');
  beforeEach(() => {
    auth.user = user('operator', 'paid_operator');
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    localStorage.clear();
  });

  it('기본 몸 GLB 등록은 같은 요청 키로만 다시 보낸다', async () => {
    const PENDING = 'gaesup.base-body-glb-pending:male';
    localStorage.setItem(PENDING, JSON.stringify({ key: 'lost-key', input: { name: '기본 남성형', body_type: 'male', model_asset: hash('a'),
      import_mode: 'register', generate_motions: false, prepare_expression_uv: false } }));
    fetchMock.mockResolvedValue(json({ id: 'body-job' }));
    const { container, unmount } = await mount(<GlbBodyForm bodyType="male" onJob={() => {}} refreshJobs={async () => {}} onBusy={() => {}} />);
    localStorage.removeItem(PENDING);
    await click(container, '같은 GLB 요청 복구');
    await settle();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sentKey()).toBe('lost-key');
    expect(localStorage.getItem(PENDING)).toBeNull();
    await unmount();
  });

  it('이미지로 만드는 기본 몸은 같은 요청 키로만 다시 보낸다', async () => {
    const PENDING = 'gaesup.base-body:male';
    localStorage.setItem(PENDING, JSON.stringify({ key: 'lost-key', input: { name: '기본 남성형', body_type: 'male',
      views: { front: hash('a'), side: hash('b'), back: hash('c') } } }));
    vi.spyOn(factoryApi, 'rigTransferSources').mockResolvedValue({ items: [] });
    fetchMock.mockResolvedValue(json({ id: 'body-job' }));
    const { container, unmount } = await mount(<BaseBodies jobs={[]} onJob={() => {}} refreshJobs={async () => {}} />);
    await settle();
    localStorage.removeItem(PENDING);
    await click(container, '같은 요청 복구');
    await settle();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sentKey()).toBe('lost-key');
    expect(localStorage.getItem(PENDING)).toBeNull();
    await unmount();
  });

  it('2D 원화 생성은 같은 요청 키로만 다시 보낸다', async () => {
    const PENDING = 'gaesup.studio.generation.illustration.v1';
    localStorage.setItem(PENDING, JSON.stringify({ key: 'lost-key', input: { kind: 'illustration', category: 'character', name: '모개', prompt: '웃는 모개', size: 1024 } }));
    vi.spyOn(generationsApi, 'list').mockResolvedValue({ items: [], capabilities: { ready: true }, defaults: { character: '기본 원화' } });
    vi.spyOn(generationsApi, 'illustrationSelection').mockResolvedValue({ selected: null, revision: '1' });
    fetchMock.mockResolvedValue(json({ id: 'art-1', request_key: 'lost-key', kind: 'illustration', category: 'character', name: '모개', prompt: '웃는 모개',
      size: 1024, status: 'accepted', stage: 'image', can_resume: false, created_at: '2026-10-01T00:00:00Z', artifacts: [] }));
    const { container, unmount } = await mount(<Emoticons />);
    await settle();
    localStorage.removeItem(PENDING);
    await click(container, '같은 요청 복구');
    await settle();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sentKey()).toBe('lost-key');
    expect(localStorage.getItem(PENDING)).toBeNull();
    await unmount();
  });

  it('GLB 에셋의 새 리깅은 같은 요청 키로만 다시 보낸다', async () => {
    const PENDING = 'gaesup.glb-assets.prepare.v1:glb-1';
    localStorage.setItem(PENDING, JSON.stringify({ key: 'lost-key', input: { action: 'rig', body_type: 'female' } }));
    vi.spyOn(glbAssetsApi, 'list').mockResolvedValue({ items: [{ id: 'glb-1', name: '몸', slot: 'body', model_asset: hash('a'), created_at: '2026-10-01T00:00:00Z',
      source: { url: '/api/studio/glb-assets/glb-1/source.glb', sha256: hash('a') }, info: { id: hash('a'), bytes: 1048576, rigged: false, bone_count: 0, triangles: 1000, animations: [] } }] });
    fetchMock.mockResolvedValue(json({ id: 'rig-job' }));
    const { container, unmount } = await mount(<GlbAssetLibrary bases={[]} onJob={() => {}} />);
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('.glb-asset-list button')!.click());
    localStorage.removeItem(PENDING);
    await click(container, '같은 후처리 요청 복구');
    await settle();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sentKey()).toBe('lost-key');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ action: 'rig', body_type: 'female' });
    expect(localStorage.getItem(PENDING)).toBeNull();
    await unmount();
  });

  it('동물 추가는 고른 그림이 남아 있어도 다시 올리지 않고 같은 요청 키로만 다시 보낸다', async () => {
    const PENDING = 'gaesup.studio.animal-create.v1';
    const input = { name: '바둑이', species: 'dog', reference: hash('a') };
    vi.spyOn(studioApi, 'animals').mockResolvedValue({ items: [] });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reference');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    fetchMock.mockResolvedValue(json({ id: 'dog-1', name: '바둑이', species: 'dog', created_at: '2026-10-01T00:00:00Z',
      stages: { views: null, model: null, rig: null, walk: null, standard: null }, production: null, artifacts: [] }));
    const { container, unmount } = await mount(<Animals />);
    await settle();
    // The picture stays chosen after the answer for its request was lost.
    await act(async () => {
      const file = container.querySelector<HTMLInputElement>('input[type=file]')!;
      Object.defineProperty(file, 'files', { value: [new File(['png'], '바둑이.png', { type: 'image/png' })], configurable: true });
      file.dispatchEvent(new Event('change', { bubbles: true }));
    });
    localStorage.setItem(PENDING, JSON.stringify({ key: 'lost-key', input }));
    // Any change renders the screen again, which then shows the saved request.
    await type([...container.querySelectorAll('label')].find(item => item.firstChild?.textContent === '이름')!.querySelector('input')!, '바둑');
    expect(container.querySelector('input[type=file]')?.closest('.animal-create')?.textContent).toContain('같은 요청 복구');
    // Another tab got the answer and forgot the saved request after this screen last looked.
    localStorage.removeItem(PENDING);
    await click(container, '같은 요청 복구');
    await settle();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/studio/animals');
    expect(sentKey()).toBe('lost-key');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(input);
    expect(localStorage.getItem(PENDING)).toBeNull();
    await unmount();
  });

  describe('표정 텍스처', () => {
    beforeEach(() => {
      vi.spyOn(expressionGenerationApi, 'list').mockResolvedValue({
        items: [], batches: [], capabilities: { ready: true, reason: null },
        defaults: { neutral: '기본 표정', smile: '웃는 표정', cry: '우는 표정', angry: '화난 표정', surprise: '놀란 표정', blink: '눈 감은 표정' },
        reference: { revision: 'r1', assets: [{ id: 'reference', url: '/reference.png' }] },
      });
    });

    it.each([
      ['하나', 'gaesup.studio.expression-generation.body-job.v1.v1', { name: 'neutral', prompt: '기본 표정', reference_assets: ['reference'] }, '같은 요청 복구'],
      ['기본 5종', 'gaesup.studio.expression-generation-batch.body-job.v1.v1', { reference_assets: ['reference'] }, '기본 5종 같은 요청 복구'],
    ])('%s 생성은 같은 요청 키로만 다시 보낸다', async (_kind, storage, input, label) => {
      localStorage.setItem(storage, JSON.stringify({ key: 'lost-key', input }));
      fetchMock.mockResolvedValue(json({ id: 'generated', request_key: 'lost-key', name: 'neutral', status: 'accepted', error: null,
        can_resume: false, artifacts: [], items: [] }));
      const { container, unmount } = await mount(<ExpressionGenerationPanel job="body-job" version="v1" ready onApply={async () => {}} />);
      await settle();
      localStorage.removeItem(storage);
      await click(container, label);
      await settle();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(sentKey()).toBe('lost-key');
      expect(localStorage.getItem(storage)).toBeNull();
      await unmount();
    });
  });
});
