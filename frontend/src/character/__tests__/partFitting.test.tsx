import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../../__tests__/mount';
import { ApiError } from '../api';
import { factoryApi, type NativePartsState, type NativePartsVersions, type PartFitProfile } from '../factory/api';
import { PartFitting } from '../studio/PartFitting';

const JOB = 'top-job', V1 = 'a'.repeat(24), V2 = 'b'.repeat(24);
const state = (changes: Partial<NativePartsState> = {}): NativePartsState => ({ status: 'review_required', version: V2, parts: [], artifacts: [], ...changes });
const saved = (current: string, ...items: string[]): NativePartsVersions => ({ current, items: items.map(version => ({ version })) });
const profile = (version: string, sleeve: 'short' | 'long'): PartFitProfile => ({
  slot: 'top', source_version: version, source_sha256: 'raw-sha', fit_profile: { revision: 'garment-fit-v1', sleeve },
});
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(10); });
const open = async () => {
  const mounted = await mount(<PartFitting jobId={JOB} slot="top" label="상의" onClose={() => undefined} onPendingSlot={() => undefined} />);
  await settle();
  return mounted;
};
const field = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('label')].find(item => item.firstChild?.textContent === label)!.querySelector('select')!;

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });

describe('피팅 패널 불러오기', () => {
  it('원본 프로필을 받기 전에 진행 중이던 피팅이 끝나도 불러오기를 마치고 새 버전을 보인다', async () => {
    vi.spyOn(factoryApi, 'nativePartsVersions').mockResolvedValueOnce(saved(V1, V1)).mockResolvedValue(saved(V2, V2, V1));
    vi.spyOn(factoryApi, 'nativeParts').mockResolvedValueOnce(state({ status: 'running', version: V1 })).mockResolvedValue(state());
    // The first version's profile is still on its way when the fit ends; only a cancel answers it.
    vi.spyOn(factoryApi, 'fitProfile').mockImplementation((_job, _slot, version, signal) => version === V2
      ? Promise.resolve(profile(V2, 'long'))
      : new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new ApiError('cancelled', '조회가 취소되었습니다.', 0)))));
    const { container, unmount } = await open();
    expect(container.textContent).toContain('피팅 정보를 불러오는 중…');
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(container.textContent).not.toContain('피팅 정보를 불러오는 중…');
    expect(field(container, '원본 버전').value).toBe(V2);
    expect(field(container, '소매').value).toBe('long');
    await unmount();
  });
});
