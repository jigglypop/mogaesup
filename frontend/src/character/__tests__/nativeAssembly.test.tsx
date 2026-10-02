import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../../__tests__/mount';
import { NativeAssembly } from '../factory/NativeAssembly';
import { factoryApi, type NativeOutfit, type NativePartsState } from '../factory/api';

const viewers = vi.hoisted(() => [] as { wear: ReturnType<typeof vi.fn> }[]);
vi.mock('../viewer', () => ({ ModelViewer: class {
  load = vi.fn(async () => []); play = vi.fn(); wear = vi.fn(async () => true); setHairColor = vi.fn(); dispose = vi.fn();
  constructor() { viewers.push(this); }
} }));
vi.mock('../studio/Expressions', () => ({ Expressions: () => null }));
vi.mock('../factory/NativePartRefit', () => ({ NativePartRefit: () => null }));
const version = 'assembly-v1';
const slots = ['hair', 'hairFront', 'hairBack', 'head', 'hat'];
const state: NativePartsState = {
  status: 'review_required', version,
  parts: ['body', ...slots].map(slot => ({ slot, objects: [slot], available: true })),
  artifacts: ['body', ...slots].map(slot => ({ name: `${slot}.glb`, url: `/stored/${version}/${slot}.glb`, sha256: `${slot}-sha` })),
};
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(10); });
const worn = () => viewers[0]!.wear.mock.calls.at(-1)![0].map((item: { slot: string }) => item.slot);

describe('저장 조립본의 머리 교체', () => {
  beforeEach(() => {
    vi.useFakeTimers(); viewers.length = 0; sessionStorage.clear();
    vi.spyOn(factoryApi, 'nativeParts').mockResolvedValue(state);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); sessionStorage.clear(); });

  it('겹친 저장을 하나의 헤어로 복원하고 앞뒤 또는 기존 머리로 바꿔도 중복 렌더·저장이 없다', async () => {
    let outfit: NativeOutfit = { version, body_sha256: 'body-sha', revision: '1', slots: ['hair', 'hairFront', 'hairBack', 'head', 'hat'] };
    vi.spyOn(factoryApi, 'nativeOutfit').mockImplementation(async () => outfit);
    const save = vi.spyOn(factoryApi, 'saveNativeOutfit').mockImplementation(async (_job, _version, input) => {
      outfit = { ...outfit, ...input, revision: '2' }; return outfit;
    });
    const { container, unmount } = await mount(<NativeAssembly jobId="hair-job" simple />); await settle();
    expect(worn()).toEqual(['hair', 'hat']);
    expect(container.textContent).toContain('겹치는 머리 파츠를 벗겼습니다');
    const check = async (label: string) => {
      const input = [...container.querySelectorAll<HTMLLabelElement>('fieldset label')].find(item => item.textContent === label)!.querySelector<HTMLInputElement>('input')!;
      await act(async () => { input.click(); }); await settle();
    };
    await check('앞머리'); await check('뒷머리');
    expect(worn()).toEqual(['hat', 'hairFront', 'hairBack']);
    await check('기존 머리 파츠');
    expect(worn()).toEqual(['head']);
    const button = [...container.querySelectorAll('button')].find(item => item.textContent === '현재 조합 저장')!;
    await act(async () => { button.click(); }); await settle();
    expect(save.mock.calls[0]![2].slots).toEqual(['head']);
    await unmount();
  });

  it('응답을 잃은 이전 조합은 원래 요청 키로 확인하고 복구 뒤의 새 저장만 호환 조합으로 보낸다', async () => {
    const outfit: NativeOutfit = { version, body_sha256: 'body-sha', revision: '1', slots: ['hair', 'hairFront'] };
    const pending = { key: 'lost-response-key', revision: '0', input: { body_sha256: 'body-sha', slots: ['hair', 'hairFront'], hair_color: null } };
    sessionStorage.setItem(`gaesup.native-outfit:hair-job:${version}`, JSON.stringify(pending));
    vi.spyOn(factoryApi, 'nativeOutfit').mockResolvedValue(outfit);
    const save = vi.spyOn(factoryApi, 'saveNativeOutfit').mockResolvedValue(outfit);
    const { container, unmount } = await mount(<NativeAssembly jobId="hair-job" simple />); await settle();
    expect(worn()).toEqual(['hair']);
    const press = async (label: string) => {
      const button = [...container.querySelectorAll('button')].find(item => item.textContent === label)!;
      await act(async () => { button.click(); }); await settle();
    };
    await press('조합 저장 결과 복구');
    expect(save).toHaveBeenNthCalledWith(1, 'hair-job', version, pending.input, pending.revision, pending.key);
    expect(sessionStorage.getItem(`gaesup.native-outfit:hair-job:${version}`)).toBeNull();
    expect(worn()).toEqual(['hair']);
    await press('현재 조합 저장');
    expect(save.mock.calls[1]![2].slots).toEqual(['hair']);
    expect(save.mock.calls[1]![4]).not.toBe(pending.key);
    await unmount();
  });
});
