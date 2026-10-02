import { act } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { Texture, TextureLoader } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { lookApi } from '../../api/endpoints';
import type { PermissionName, User } from '../../api/types';
import { mount, type } from '../../__tests__/mount';
import { ApiError } from '../api';
import { factoryApi, type WardrobeBody, type WardrobeOutfit, type WardrobePart, type WardrobeUnavailable } from '../factory/api';
import Wardrobe from '../studio/Wardrobe';

const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: auth.user, status: 'signedIn' }) }));

// The WebGPU viewer is not what is tested: it only has to take parts on and off and say what it was told.
const viewers = vi.hoisted(() => [] as { wear: ReturnType<typeof vi.fn>; setPartColors: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[]);
vi.mock('../viewer', () => ({
  ModelViewer: class {
    load = vi.fn(async () => []);
    play = vi.fn();
    wear = vi.fn(async () => true);
    setHairColor = vi.fn();
    setHiddenBodyTriangles = vi.fn();
    setTucked = vi.fn();
    setPartColors = vi.fn();
    dispose = vi.fn();
    constructor() {
      viewers.push(this);
    }
  },
}));

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
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
});
