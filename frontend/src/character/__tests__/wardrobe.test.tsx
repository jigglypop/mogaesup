import { act } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { Texture, TextureLoader } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { lookApi } from '../../api/endpoints';
import type { Look, PermissionName, User } from '../../api/types';
import { mount, type } from '../../__tests__/mount';
import { ApiError } from '../api';
import { factoryApi, type WardrobeBody, type WardrobeOutfit, type WardrobePart, type WardrobeUnavailable } from '../factory/api';
import Wardrobe from '../studio/Wardrobe';

const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: auth.user, status: 'signedIn' }) }));

// The WebGPU viewer is not what is tested: it only has to take parts on and off and say what it was told.
const viewers = vi.hoisted(() => [] as { wear: ReturnType<typeof vi.fn>; setPartColors: ReturnType<typeof vi.fn>; setHiddenBodyTriangles: ReturnType<typeof vi.fn>; setTucked: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[]);
/** How many of the next body loads fail. */
const bodyLoads = vi.hoisted(() => ({ failing: 0 }));
vi.mock('../viewer', () => ({
  ModelViewer: class {
    load = vi.fn(async () => {
      if (bodyLoads.failing > 0) { bodyLoads.failing--; throw new Error('모델 파일 불러오기 시간이 초과되었습니다.'); }
      return [];
    });
    play = vi.fn();
    wear = vi.fn(async () => true);
    setHairColor = vi.fn();
    setHiddenBodyTriangles = vi.fn();
    setTucked = vi.fn();
    setPartColors = vi.fn();
    setPartEdit = vi.fn();
    dispose = vi.fn();
    constructor() {
      viewers.push(this);
    }
  },
}));
// Drawing a part's model needs a GPU; here it only has to be asked for and hand back a picture.
const thumbnails = vi.hoisted(() => ({ drawable: false, draw: vi.fn() }));
vi.mock('../part-thumbnails', () => ({ canDrawThumbnails: () => thumbnails.drawable, partThumbnail: thumbnails.draw }));

const body: WardrobeBody = {
  job_id: 'body-job',
  version: 'v1',
  profile_id: 'profile',
  body_sha256: 'body-sha',
  geometry_sha256: 'geometry-sha',
  name: '기본 몸',
  registered_at: '2026-09-30T00:00:00Z',
  is_default: true,
  part_jobs: 2,
};
const part = (job: string, slot: string, name: string, changes: Partial<WardrobePart> = {}): WardrobePart => ({
  job_id: job,
  version: 'v1',
  slot,
  name,
  sha256: `${job}-sha`,
  fit_method: 'worn-extract-v1',
  ...changes,
});
const user = (...permissions: PermissionName[]): User => ({ id: 'u1', username: 'mogae', displayName: '모개', role: 'user', permissions });

const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
const click = (element: Element | null | undefined) => act(async () => (element as HTMLElement).click());
const card = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.wardrobe-card')].find((item) => item.querySelector('strong')?.textContent === name);
const cardNames = (container: HTMLElement) => [...container.querySelectorAll('.wardrobe-card strong')].map((item) => item.textContent);
const tab = (container: HTMLElement, label: string) => [...container.querySelectorAll<HTMLElement>('[role=tab]')].find((item) => item.textContent?.startsWith(label));
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);

let parts: WardrobePart[];
let unavailable: WardrobeUnavailable[];
let outfits: Record<string, WardrobeOutfit>;
let colors: MockInstance<typeof factoryApi.wardrobeColors>;
let outfitList: MockInstance<typeof factoryApi.wardrobeOutfits>;
let loadMask: MockInstance<TextureLoader['loadAsync']>;
const textures: Texture[] = [];
/** A mask the loader hands over, kept to see whether it was let go. */
const maskTexture = () => {
  const texture = new Texture() as Texture<HTMLImageElement>;
  vi.spyOn(texture, 'dispose');
  textures.push(texture);
  return texture;
};

const open = () =>
  mount(
    <MemoryRouter>
      <Wardrobe />
    </MemoryRouter>,
  );

describe('옷장', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    parts = [part('top-job', 'top', '후드'), part('top-bad', 'top', '맞지 않는 옷', { fit_check: { status: 'fail', failures: ['소매가 몸을 뚫습니다.'] } })];
    unavailable = [];
    outfits = {};
    viewers.length = 0;
    textures.length = 0;
    colors = vi.spyOn(factoryApi, 'wardrobeColors');
    outfitList = vi.spyOn(factoryApi, 'wardrobeOutfits');
    loadMask = vi.spyOn(TextureLoader.prototype, 'loadAsync');
    vi.spyOn(factoryApi, 'wardrobeBodies').mockResolvedValue({ revision: '1', bodies: [body], default: { job_id: body.job_id, version: body.version } });
    vi.spyOn(factoryApi, 'wardrobeParts').mockImplementation(async () => ({ body, parts, unavailable }));
    outfitList.mockImplementation(async () => ({ revision: '1', outfits }));
    colors.mockImplementation(async (item) => ({ slot: item.slot, material: 0, regions: [{ index: 0, color: '#ff0000', share: 1, light: 0.5 }] }));
    vi.spyOn(factoryApi, 'wardrobeCoverage').mockImplementation(async (_body, item) => ({ slot: item.slot, hidden: {}, triangles: {}, covers_bottom: false }));
    vi.spyOn(lookApi, 'mine').mockResolvedValue({ look: null });
    loadMask.mockImplementation(async () => maskTexture());
    auth.user = user();
    bodyLoads.failing = 0;
    thumbnails.drawable = false;
    thumbnails.draw.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('다시 열면 내 캐릭터의 저장된 파츠와 옷 색을 복원해서 같은 요청을 저장한다', async () => {
    const saved: Look = {
      request: { body: { jobId: body.job_id, version: body.version }, parts: { top: { jobId: 'top-job', version: 'v1', sha256: 'top-job-sha' } }, hairColor: null, colors: { top: { '0': '#abcdef' } } },
      status: 'ready', worn: true, modelUrl: '/models/look.glb', error: null, updatedAt: '2026-10-01T00:00:00Z',
    };
    vi.mocked(lookApi.mine).mockResolvedValue({ look: saved });
    const save = vi.spyOn(lookApi, 'save').mockResolvedValue({ look: { ...saved, status: 'baking' } });
    const { container, unmount } = await open(); await settle();
    expect(container.querySelector('.wardrobe-worn')?.textContent).toContain('후드');
    expect(container.querySelector<HTMLInputElement>('.wardrobe-swatches input')?.value).toBe('#abcdef');
    await click(button(container, '내 캐릭터로 입기')); await settle();
    expect(save).toHaveBeenCalledExactlyOnceWith(saved.request);
    await unmount();
  });

  it('회원의 저장된 헤어 크기·위치를 복원해 다시 저장하고 원래대로 되돌릴 수 있다', async () => {
    const hair = part('hair-job', 'hair', '단발'); parts = [hair];
    const edit = { scale: [1.1, 1, .9] as [number, number, number], translation: [.01, -.005, 0] as [number, number, number] };
    const saved: Look = { request: { body: { jobId: body.job_id, version: body.version }, parts: { hair: { jobId: hair.job_id, version: hair.version, sha256: hair.sha256 } }, hairColor: null, colors: {}, partEdits: { hair: edit } }, status: 'ready', worn: true, modelUrl: '/models/look.glb', error: null, updatedAt: '' };
    vi.mocked(lookApi.mine).mockResolvedValue({ look: saved });
    const save = vi.spyOn(lookApi, 'save').mockResolvedValue({ look: saved });
    const { container, unmount } = await open(); await settle();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="헤어 가로 크기"]')?.value).toBe('1.1');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="헤어 상하 위치"]')?.value).toBe('-0.005');
    await click(button(container, '내 캐릭터로 입기')); await settle(); expect(save).toHaveBeenLastCalledWith(saved.request);
    await click(button(container, '원래 크기와 위치')); await settle();
    await click(button(container, '내 캐릭터로 입기')); await settle();
    expect(save.mock.calls.at(-1)![0].partEdits).toBeUndefined();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="헤어 가로 크기"]')?.value).toBe('1');
    await unmount();
  });

  it('수정한 모자의 원본 coverage로 피부를 지우거나 헤어를 누르지 않고 복구하면 다시 적용한다', async () => {
    const hair = part('hair-job', 'hair', '헤어'), hat = part('hat-job', 'hat', '모자'); parts = [hair, hat];
    const encode = (values: Uint8Array) => btoa(String.fromCharCode(...values));
    const anchor = encode(new Uint8Array(new Int32Array([0]).buffer)), move = encode(new Uint8Array(new Float32Array([0, 0, -.01]).buffer));
    vi.mocked(factoryApi.wardrobeCoverage).mockImplementation(async (_body, item) => item.slot === 'hat'
      ? { slot: 'hat', hidden: { '0:0': encode(new Uint8Array([2])) }, triangles: {}, covers_bottom: false, covers_head: true }
      : { slot: 'hair', hidden: { '0:0': encode(new Uint8Array([1])) }, triangles: {}, covers_bottom: false, anchors: { '0:0': anchor }, tucks: { '0:0': move }, anchor_keys: ['0:0'], under: ['hat'] });
    const saved: Look = { request: { body: { jobId: body.job_id, version: body.version }, parts: Object.fromEntries(parts.map(item => [item.slot, { jobId: item.job_id, version: item.version, sha256: item.sha256 }])), hairColor: null, colors: {}, partEdits: { hat: { scale: [.8, .8, .8], translation: [0, .05, 0] } } }, status: 'ready', worn: true, modelUrl: '/models/look.glb', error: null, updatedAt: '' };
    vi.mocked(lookApi.mine).mockResolvedValue({ look: saved });
    const { container, unmount } = await open(); await settle();
    expect(viewers[0]!.setHiddenBodyTriangles).toHaveBeenLastCalledWith({ '0:0': new Uint8Array([1]) });
    expect(viewers[0]!.setTucked).toHaveBeenLastCalledWith('hair', expect.any(Object), null);
    const reset = container.querySelector('input[aria-label$="가로 크기"][value="0.8"]')?.closest('fieldset')?.querySelector('button');
    await click(reset); await settle();
    expect(viewers[0]!.setHiddenBodyTriangles).toHaveBeenLastCalledWith({ '0:0': new Uint8Array([3]) });
    expect(viewers[0]!.setTucked).toHaveBeenLastCalledWith('hair', expect.any(Object), { '0:0': new Uint8Array([2]) });
    await unmount();
  });

  it('내 캐릭터의 최초 읽기를 기다리는 동안 빈 조합으로 저장하지 못한다', async () => {
    let answer!: (value: { look: Look | null }) => void;
    vi.mocked(lookApi.mine).mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const { container, unmount } = await open(); await settle();
    expect(button(container, '내 캐릭터로 입기')?.disabled).toBe(true);
    await act(async () => { answer({ look: null }); }); await settle();
    expect(button(container, '내 캐릭터로 입기')?.disabled).toBe(false);
    await unmount();
  });

  it('다른 몸과 헤어 색으로 저장했던 캐릭터도 해당 몸의 파츠를 불러와 복원한다', async () => {
    const other = { ...body, job_id: 'other-body', version: 'v2', name: '다른 몸', is_default: false };
    const hair = part('hair-job', 'hair', '단발');
    vi.mocked(factoryApi.wardrobeBodies).mockResolvedValue({ revision: '1', bodies: [body, other], default: { job_id: body.job_id, version: body.version } });
    vi.mocked(factoryApi.wardrobeParts).mockImplementation(async job => ({ body: job === other.job_id ? other : body, parts: job === other.job_id ? [hair] : parts, unavailable: [] }));
    const saved: Look = { request: { body: { jobId: other.job_id, version: other.version }, parts: { hair: { jobId: hair.job_id, version: hair.version, sha256: hair.sha256 } }, hairColor: '#123456', colors: {} }, status: 'ready', worn: true, modelUrl: '/models/look.glb', error: null, updatedAt: '' };
    vi.mocked(lookApi.mine).mockResolvedValue({ look: saved });
    const save = vi.spyOn(lookApi, 'save').mockResolvedValue({ look: { ...saved, status: 'baking' } });
    const { container, unmount } = await open(); await settle();
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="옷장 몸"]')?.value).toBe('other-body');
    expect(container.querySelector('.wardrobe-worn')?.textContent).toContain('단발');
    expect(container.querySelector<HTMLInputElement>('.wardrobe-hair-color input')?.value).toBe('#123456');
    await click(button(container, '내 캐릭터로 입기')); await settle();
    expect(save).toHaveBeenCalledExactlyOnceWith(saved.request); await unmount();
  });

  it('느린 look polling은 중첩하지 않고 화면이 닫힌 뒤 요청을 취소한다', async () => {
    const saved: Look = { request: { body: { jobId: body.job_id, version: body.version }, parts: {}, hairColor: null, colors: {} }, status: 'baking', worn: false, modelUrl: null, error: null, updatedAt: '' };
    vi.mocked(lookApi.mine).mockResolvedValueOnce({ look: saved });
    let answer!: (value: { look: Look | null }) => void;
    vi.mocked(lookApi.mine).mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const { container, unmount } = await open(); await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(lookApi.mine).toHaveBeenCalledTimes(2);
    const signal = vi.mocked(lookApi.mine).mock.calls[1]?.[0];
    await unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => { answer({ look: null }); });
    expect(container.querySelector('.wardrobe-look')).toBeNull();
  });

  it('전체 헤어와 분리 헤어를 교체하면서 앞뒤만 함께 저장한다', async () => {
    parts = [part('full', 'hair', '전체 머리'), part('front', 'hairFront', '분리 앞머리'), part('back', 'hairBack', '분리 뒷머리')];
    const save = vi.spyOn(lookApi, 'save').mockImplementation(async request => ({ look: { request, status: 'baking', worn: false, modelUrl: null, error: null, updatedAt: '' } }));
    const { container, unmount } = await open(); await settle();
    await click(card(container, '전체 머리')); await settle();
    await click(tab(container, '앞머리')); await click(card(container, '분리 앞머리')); await settle();
    await click(tab(container, '뒷머리')); await click(card(container, '분리 뒷머리')); await settle();
    expect(container.querySelector('.wardrobe-worn')?.textContent).not.toContain('전체 머리');
    await click(button(container, '내 캐릭터로 입기')); await settle();
    expect(Object.keys(save.mock.calls[0]![0].parts)).toEqual(['hairFront', 'hairBack']);
    await click(tab(container, '헤어')); await click(card(container, '전체 머리')); await settle();
    expect(container.querySelector('.wardrobe-worn')?.textContent).not.toContain('분리 앞머리');
    expect(container.querySelector('.wardrobe-worn')?.textContent).not.toContain('분리 뒷머리');
    await unmount();
  });

  it('이전 저장에서 겹친 헤어를 복원해도 미리보기와 새 저장에는 전체 헤어만 쓴다', async () => {
    parts = [part('full', 'hair', '전체 머리'), part('front', 'hairFront', '분리 앞머리')];
    const request: Look['request'] = { body: { jobId: body.job_id, version: body.version }, parts: {
      hair: { jobId: 'full', version: 'v1', sha256: 'full-sha' }, hairFront: { jobId: 'front', version: 'v1', sha256: 'front-sha' },
    }, hairColor: null, colors: {} };
    vi.mocked(lookApi.mine).mockResolvedValue({ look: { request, status: 'ready', worn: true, modelUrl: '/models/old.glb', error: null, updatedAt: '' } });
    const save = vi.spyOn(lookApi, 'save').mockImplementation(async request => ({ look: { request, status: 'baking', worn: false, modelUrl: null, error: null, updatedAt: '' } }));
    const { container, unmount } = await open(); await settle();
    expect(container.textContent).toContain('겹치는 머리 파츠를 벗겼습니다: 앞머리');
    expect(viewers[0]!.wear.mock.calls.at(-1)![0].map((value: { slot: string }) => value.slot)).toEqual(['hair']);
    await click(button(container, '내 캐릭터로 입기')); await settle();
    expect(Object.keys(save.mock.calls[0]![0].parts)).toEqual(['hair']);
    await unmount();
  });

  it('같은 몸 작업의 버전이 교체되면 파츠를 즉시 다시 읽고 이전 버전 파츠를 거부한다', async () => {
    const next = { ...body, version: 'v2', body_sha256: 'new-body', geometry_sha256: 'new-geometry' };
    const { container, unmount } = await open(); await settle();
    const before = vi.mocked(factoryApi.wardrobeParts).mock.calls.length;
    vi.mocked(factoryApi.wardrobeBodies).mockResolvedValue({ revision: '2', bodies: [next], default: { job_id: next.job_id, version: next.version } });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); }); await settle();
    expect(vi.mocked(factoryApi.wardrobeParts).mock.calls.length).toBeGreaterThan(before + 1);
    expect(cardNames(container)).toEqual([]);
    expect(container.textContent).toContain('몸과 파츠의 버전이 다릅니다');
    expect(button(container, '내 캐릭터로 입기')?.disabled).toBe(true);
    await unmount();
  });

  it('새 몸 버전에서 같은 파츠를 다시 입으면 이전 가림 영역을 재사용하지 않는다', async () => {
    let selectedBody = body;
    vi.mocked(factoryApi.wardrobeBodies).mockImplementation(async () => ({ revision: selectedBody.version, bodies: [selectedBody], default: { job_id: selectedBody.job_id, version: selectedBody.version } }));
    vi.mocked(factoryApi.wardrobeParts).mockImplementation(async () => ({ body: selectedBody, parts, unavailable: [] }));
    const { container, unmount } = await open(); await settle();
    await click(card(container, '후드')); await settle();
    expect(factoryApi.wardrobeCoverage).toHaveBeenCalledTimes(1);
    selectedBody = { ...body, version: 'v2', body_sha256: 'new-body', geometry_sha256: 'new-geometry' };
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); }); await settle();
    await click(card(container, '후드')); await settle();
    expect(factoryApi.wardrobeCoverage).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.wardrobe-worn')?.textContent).toContain('후드');
    await unmount();
  });

  describe('누가 무엇을 보는가', () => {
    it('운영자가 아니어도 핏 검사에서 떨어진 파츠를 목록에서 본다', async () => {
      const { container, unmount } = await open();
      await settle();
      expect(cardNames(container)).toEqual(['후드', '맞지 않는 옷']);
      expect(tab(container, '상의')?.textContent).toContain('2');
      expect(container.textContent).not.toContain('소매가 몸을 뚫습니다.');
      await unmount();
    });

    it('운영자는 떨어진 파츠와 그 이유를 본다', async () => {
      auth.user = user('operator');
      const { container, unmount } = await open();
      await settle();
      expect(cardNames(container)).toEqual(['후드', '맞지 않는 옷']);
      expect(container.textContent).toContain('소매가 몸을 뚫습니다.');
      await unmount();
    });

    describe('피팅하지 못한 파츠', () => {
      beforeEach(() => {
        unavailable = [
          { job_id: 'anchors', version: 'v1', slot: 'top', name: '긴 코트', reason: 'needs_anchors' },
          { job_id: 'broken', version: 'v1', slot: 'bottom', name: '청바지', reason: 'fit_exception' },
          { job_id: 'other', version: 'v1', slot: 'hat', name: '모자', reason: 'something_new' },
        ];
      });

      it('운영자는 이름, 파츠 종류, 이유를 본다', async () => {
        auth.user = user('operator');
        const { container, unmount } = await open();
        await settle();
        const rows = [...container.querySelectorAll('.wardrobe-unfit li')].map((item) => item.textContent);
        expect(rows).toEqual(['긴 코트상의 · 피팅 기준점 필요', '청바지하의 · 피팅 중 오류', '모자모자·머리 장식 · 피팅 실패']);
        expect(cardNames(container)).toEqual(['후드', '맞지 않는 옷']);
        await unmount();
      });

      it('회원에게는 아무것도 보이지 않는다', async () => {
        const { container, unmount } = await open();
        await settle();
        expect(container.querySelector('.wardrobe-unfit')).toBeNull();
        expect(container.textContent).not.toContain('긴 코트');
        expect(container.textContent).not.toContain('피팅 기준점 필요');
        await unmount();
      });

      it('목록이 비어 있으면 아무것도 그리지 않는다', async () => {
        unavailable = [];
        auth.user = user('operator');
        const { container, unmount } = await open();
        await settle();
        expect(container.querySelector('.wardrobe-unfit')).toBeNull();
        await unmount();
      });
    });

    it.each([
      ['회원', [], false],
      ['운영자', ['operator'], false],
      ['유료 운영자', ['operator', 'paid_operator'], true],
    ] as const)('%s에게는 몸에 맞춘 상의의 모양 조절이 %s', async (_who, permissions, shown) => {
      parts = [part('shell-top', 'top', '몸 셸 상의', { fit_method: 'body-shell-v1' })];
      auth.user = user(...permissions);
      const { container, unmount } = await open();
      await settle();
      await click(card(container, '몸 셸 상의'));
      await settle();
      expect(container.querySelector('.wardrobe-worn')?.textContent).toContain('몸 셸 상의');
      expect(!!container.querySelector('.wardrobe-shapes')).toBe(shown);
      expect(!!button(container, '다시 만들기')).toBe(shown);
      await unmount();
    });
  });

  describe('옷 색 마스크', () => {
    it('입은 파츠마다 한 번 받아 색을 보이고, 벗으면 풀며, 다시 입으면 새로 받는다', async () => {
      const { container, unmount } = await open();
      await settle();
      await click(card(container, '후드'));
      await settle();
      expect(loadMask).toHaveBeenCalledTimes(1);
      expect(container.querySelector('.wardrobe-colors')).not.toBeNull();
      expect(viewers[0]?.setPartColors).toHaveBeenCalled();
      expect(textures[0]?.dispose).not.toHaveBeenCalled();

      await click(button(container, '벗기기'));
      await settle();
      expect(textures[0]?.dispose).toHaveBeenCalledTimes(1);
      expect(container.querySelector('.wardrobe-colors')).toBeNull();

      await click(card(container, '후드'));
      await settle();
      expect(loadMask).toHaveBeenCalledTimes(2);
      expect(textures[1]?.dispose).not.toHaveBeenCalled();
      expect(container.querySelector('.wardrobe-colors')).not.toBeNull();

      await unmount();
      expect(textures[1]?.dispose).toHaveBeenCalledTimes(1);
    });

    it('받는 중에 다른 파츠를 입어도 받던 것을 버리지도 다시 받지도 않는다', async () => {
      parts = [part('top-job', 'top', '후드'), part('bottom-job', 'bottom', '청바지')];
      let finishTop!: () => void;
      loadMask.mockImplementationOnce(async () => {
        await new Promise<void>((done) => (finishTop = done));
        return maskTexture();
      });
      const { container, unmount } = await open();
      await settle();
      await click(card(container, '후드'));
      await settle();
      expect(loadMask).toHaveBeenCalledTimes(1);

      await click(tab(container, '하의'));
      await click(card(container, '청바지'));
      await settle();
      // 청바지의 마스크만 새로 받는다. 후드의 것은 아직 오는 중이다.
      expect(loadMask).toHaveBeenCalledTimes(2);

      finishTop();
      await settle();
      expect(loadMask).toHaveBeenCalledTimes(2);
      expect(textures.every((texture) => !vi.mocked(texture.dispose).mock.calls.length)).toBe(true);
      expect(container.querySelectorAll('.wardrobe-colors li')).toHaveLength(2);
      await unmount();
    });

    it('받는 중에 벗으면 늦게 도착한 마스크는 바로 풀고 쓰지 않는다', async () => {
      let finish!: () => void;
      loadMask.mockImplementationOnce(async () => {
        await new Promise<void>((done) => (finish = done));
        return maskTexture();
      });
      const { container, unmount } = await open();
      await settle();
      await click(card(container, '후드'));
      await settle();
      await click(button(container, '벗기기'));
      await settle();
      expect(textures).toHaveLength(0);

      finish();
      await settle();
      expect(textures).toHaveLength(1);
      expect(textures[0]?.dispose).toHaveBeenCalledTimes(1);
      expect(container.querySelector('.wardrobe-colors')).toBeNull();
      expect(loadMask).toHaveBeenCalledTimes(1);
      await unmount();
    });

    it('마스크가 없는 파츠는 색 칸 없이 원래 색을 쓴다', async () => {
      colors.mockRejectedValueOnce(new ApiError('request_failed', '색 정보 없음', 404));
      const { container, unmount } = await open();
      await settle();
      await click(card(container, '후드'));
      await settle();
      expect(container.querySelector('.wardrobe-colors')).toBeNull();
      expect(loadMask).not.toHaveBeenCalled();
      await unmount();
    });
  });

  describe('조합 저장', () => {
    const conflict = () => new ApiError('revision_conflict', '목록이 바뀌었습니다. 새로 불러온 뒤 다시 저장해 주세요.', 409);

    it('저장이 리비전 충돌로 거절되면 조합 목록을 다시 읽는다', async () => {
      auth.user = user('operator');
      vi.spyOn(factoryApi, 'saveWardrobeOutfit').mockRejectedValue(conflict());
      const { container, unmount } = await open();
      await settle();
      await click(card(container, '후드'));
      await settle();
      await type(container.querySelector<HTMLInputElement>('.wardrobe-save input')!, '새 조합');
      expect(outfitList).toHaveBeenCalledTimes(1);

      await click(button(container, '조합 저장'));
      await settle();
      expect(container.textContent).toContain('목록이 바뀌었습니다');
      expect(outfitList).toHaveBeenCalledTimes(2);
      await unmount();
    });

    it('다른 이유로 거절되면 다시 읽지 않는다', async () => {
      auth.user = user('operator');
      vi.spyOn(factoryApi, 'saveWardrobeOutfit').mockRejectedValue(new ApiError('invalid', '이름을 확인해 주세요.', 422));
      const { container, unmount } = await open();
      await settle();
      await click(card(container, '후드'));
      await settle();
      await type(container.querySelector<HTMLInputElement>('.wardrobe-save input')!, '새 조합');
      await click(button(container, '조합 저장'));
      await settle();
      expect(container.textContent).toContain('이름을 확인해 주세요.');
      expect(outfitList).toHaveBeenCalledTimes(1);
      await unmount();
    });

    it('삭제가 리비전 충돌로 거절되면 조합 목록을 다시 읽는다', async () => {
      auth.user = user('operator');
      outfits = { saved: { name: '저장한 조합', body: { job_id: body.job_id, version: body.version }, parts: {}, saved_at: '2026-09-30T00:00:00Z' } };
      vi.spyOn(factoryApi, 'deleteWardrobeOutfit').mockRejectedValue(conflict());
      const { container, unmount } = await open();
      await settle();
      expect(outfitList).toHaveBeenCalledTimes(1);
      await click(button(container, '삭제'));
      await settle();
      expect(container.textContent).toContain('목록이 바뀌었습니다');
      expect(outfitList).toHaveBeenCalledTimes(2);
      await unmount();
    });
  });

  describe('파츠 종류 탭', () => {
    it('방향키로 다음 종류로 옮기고, 고른 탭이 카드 목록 패널을 가리킨다', async () => {
      parts = [part('top-job', 'top', '후드'), part('bottom-job', 'bottom', '청바지')];
      const { container, unmount } = await open();
      await settle();
      const top = tab(container, '상의')!, bottom = tab(container, '하의')!;
      expect(container.querySelector('[role=tablist]')?.getAttribute('aria-label')).toBe('파츠 종류');
      expect([top.tabIndex, bottom.tabIndex]).toEqual([0, -1]);
      await act(async () => { top.focus(); top.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
      expect(bottom.getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe(bottom);
      const panel = container.querySelector('[role=tabpanel]')!;
      expect(panel.getAttribute('aria-labelledby')).toBe(bottom.id);
      expect(bottom.getAttribute('aria-controls')).toBe(panel.id);
      expect(cardNames(container)).toEqual(['청바지']);
      await act(async () => { bottom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
      expect(cardNames(container)).toEqual(['후드']);
      await unmount();
    });
  });

  describe('불러오지 못했을 때', () => {
    it('몸 목록을 읽지 못하면 그 이유와 다시 불러오기를 보이고, 다시 읽으면 화면이 열린다', async () => {
      vi.mocked(factoryApi.wardrobeBodies).mockRejectedValueOnce(new ApiError('request_failed', '몸 목록을 읽지 못했습니다.', 502));
      const { container, unmount } = await open();
      await settle();
      expect(container.querySelector('[role=alert]')?.textContent).toContain('몸 목록을 읽지 못했습니다.');
      expect(container.textContent).not.toContain('옷장 몸을 불러오는 중');
      await click(button(container, '몸 목록 다시 불러오기'));
      await settle();
      expect(factoryApi.wardrobeBodies).toHaveBeenCalledTimes(2);
      expect(container.textContent).not.toContain('몸 목록을 읽지 못했습니다.');
      expect(cardNames(container)).toEqual(['후드', '맞지 않는 옷']);
      await unmount();
    });

    it('가림 영역 하나를 읽지 못해도 내 캐릭터 저장과 조합 저장은 막지 않고, 그것만 다시 읽는다', async () => {
      auth.user = user('operator');
      vi.mocked(factoryApi.wardrobeCoverage).mockRejectedValueOnce(new ApiError('request_failed', '가림 정보를 읽지 못했습니다.', 502));
      const { container, unmount } = await open();
      await settle();
      await click(card(container, '후드'));
      await settle();
      expect(container.textContent).toContain('상의 가림 영역: 가림 정보를 읽지 못했습니다.');
      expect(button(container, '내 캐릭터로 입기')?.disabled).toBe(false);
      await type(container.querySelector<HTMLInputElement>('.wardrobe-save input')!, '새 조합');
      expect(button(container, '조합 저장')?.disabled).toBe(false);
      await click(button(container, '가림 영역 다시 불러오기'));
      await settle();
      expect(factoryApi.wardrobeCoverage).toHaveBeenCalledTimes(2);
      expect(container.textContent).not.toContain('가림 정보를 읽지 못했습니다.');
      await unmount();
    });

    const saved: Look = {
      request: { body: { jobId: body.job_id, version: body.version }, parts: { top: { jobId: 'top-job', version: 'v1', sha256: 'top-job-sha' } }, hairColor: null, colors: {} },
      status: 'ready', worn: true, modelUrl: '/models/look.glb', error: null, updatedAt: '',
    };

    it('저장된 캐릭터를 복원하던 중 몸 모델을 받지 못해도 화면이 멈추지 않고, 다시 불러오면 그 캐릭터를 입힌다', async () => {
      vi.mocked(lookApi.mine).mockResolvedValue({ look: saved });
      bodyLoads.failing = 1;
      const { container, unmount } = await open();
      await settle();
      expect(container.textContent).toContain('모델 파일 불러오기 시간이 초과되었습니다.');
      expect(container.textContent).not.toContain('내 캐릭터를 불러오는 중');
      expect(container.querySelector<HTMLSelectElement>('select[aria-label="옷장 몸"]')?.disabled).toBe(false);
      await click(button(container, '다시 불러오기'));
      await settle();
      expect(container.querySelector('.wardrobe-worn')?.textContent).toContain('후드');
      await unmount();
    });

    it('저장된 캐릭터를 복원하던 중 파츠 목록을 읽지 못해도 화면이 멈추지 않고, 목록이 오면 그 캐릭터를 입힌다', async () => {
      vi.mocked(lookApi.mine).mockResolvedValue({ look: saved });
      vi.mocked(factoryApi.wardrobeParts).mockRejectedValueOnce(new ApiError('request_failed', '파츠 목록을 읽지 못했습니다.', 502));
      const { container, unmount } = await open();
      await settle();
      expect(container.textContent).toContain('파츠 목록을 읽지 못했습니다.');
      expect(container.textContent).not.toContain('내 캐릭터를 불러오는 중');
      expect(container.querySelector<HTMLSelectElement>('select[aria-label="옷장 몸"]')?.disabled).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      await settle();
      expect(container.querySelector('.wardrobe-worn')?.textContent).toContain('후드');
      await unmount();
    });
  });

  describe('등록된 옷장 몸이 없을 때', () => {
    beforeEach(() => {
      vi.mocked(factoryApi.wardrobeBodies).mockResolvedValue({ revision: '1', bodies: [], default: null });
    });

    it.each([
      ['회원', []],
      ['유료가 아닌 운영자', ['operator']],
    ] as const)('%s에게는 등록하라는 안내 없이 비어 있다고만 보인다', async (_who, permissions) => {
      auth.user = user(...permissions);
      const { container, unmount } = await open();
      await settle();
      expect(container.querySelector('.wardrobe-empty')?.textContent).toBe('등록된 옷장 몸이 없습니다.');
      expect(container.querySelector('.wardrobe-empty a')).toBeNull();
      await unmount();
    });

    it('기본몸 화면을 여는 유료 운영자에게는 그 화면으로 가는 링크를 보인다', async () => {
      auth.user = user('operator', 'paid_operator');
      const { container, unmount } = await open();
      await settle();
      const link = container.querySelector<HTMLAnchorElement>('.wardrobe-empty a');
      expect(link?.textContent).toBe('기본몸 화면에서 등록');
      expect(link?.getAttribute('href')).toBe('/admin/studio/make/body');
      await unmount();
    });
  });

  describe('카드 그림', () => {
    const fail = (container: HTMLElement, name: string) =>
      act(async () => { card(container, name)!.querySelector('img')!.dispatchEvent(new Event('error')); });
    const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

    it('정면 그림이 없는 파츠(올린 GLB)는 그 모델을 찍은 그림을 보인다', async () => {
      thumbnails.drawable = true;
      thumbnails.draw.mockResolvedValue({ src: 'data:image/webp;base64,AAAA', renderer: 'webgpu' });
      vi.stubGlobal('fetch', answer(404, { error: { code: 'preview_missing', message: '이 파츠에는 정면 그림이 없습니다.' } }));
      const { container, unmount } = await open();
      await settle();
      await fail(container, '후드');
      await settle();
      const picture = card(container, '후드')!.querySelector('img');
      expect(picture?.getAttribute('src')).toBe('data:image/webp;base64,AAAA');
      expect(picture?.dataset['renderer']).toBe('webgpu');
      expect(thumbnails.draw).toHaveBeenCalledWith('/api/avatar-factory/jobs/top-job/native-parts/v1/top.glb', 'top-job-sha', expect.any(AbortSignal));
      await unmount();
    });

    it('3D 그림을 그릴 수 없는 브라우저에서는 파츠 종류 이름을 보인다', async () => {
      vi.stubGlobal('fetch', answer(404, { error: { code: 'preview_missing', message: '없음' } }));
      const { container, unmount } = await open();
      await settle();
      await fail(container, '후드');
      await settle();
      expect(card(container, '후드')!.querySelector('.wardrobe-card-empty')?.textContent).toBe('상의');
      expect(thumbnails.draw).not.toHaveBeenCalled();
      await unmount();
    });

    it('잠깐 실패한 그림은 이름으로 두었다가 목록을 다시 읽으면 다시 받아 본다', async () => {
      const probe = answer(502, {});
      vi.stubGlobal('fetch', probe);
      const { container, unmount } = await open();
      await settle();
      await fail(container, '후드');
      await settle();
      expect(probe).toHaveBeenCalledOnce();
      expect(card(container, '후드')!.querySelector('img')).toBeNull();
      expect(card(container, '후드')!.querySelector('.wardrobe-card-empty')?.textContent).toBe('상의');
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      await settle();
      expect(card(container, '후드')!.querySelector('img')?.getAttribute('src')).toContain('attempt=1');
      await unmount();
    });
  });
});
