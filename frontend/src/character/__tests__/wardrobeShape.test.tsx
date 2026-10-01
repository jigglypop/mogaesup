import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { mount } from '../../__tests__/mount';
import { factoryApi, type NativePartsState, type WardrobePart } from '../factory/api';
import { WardrobeShape } from '../studio/WardrobeShape';

const part: WardrobePart = { job_id: 'top-job', version: 'v1', slot: 'top', name: '몸 셸 상의', sha256: 'sha', fit_method: 'body-shell-v1' };
const native = (changes: Partial<NativePartsState>): NativePartsState => ({ status: 'running', artifacts: [], parts: [], ...changes });
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const rebuild = (container: HTMLElement) => act(async () => [...container.querySelectorAll('button')].find((item) => item.textContent === '다시 만들기')!.click());

describe('옷 모양 다시 만들기', () => {
  const reload = vi.fn<(signal?: AbortSignal) => Promise<WardrobePart[]>>();
  const replace = vi.fn<(next: WardrobePart) => void>();
  let nativeParts: MockInstance<typeof factoryApi.nativeParts>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(factoryApi, 'refitPart').mockResolvedValue(native({}));
    nativeParts = vi.spyOn(factoryApi, 'nativeParts');
    reload.mockResolvedValue([part]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    reload.mockReset();
    replace.mockReset();
  });
  const open = () => mount(<WardrobeShape part={part} label="상의" reload={reload} replace={replace} />);

  it('새 버전이 만들어져 옷장 목록에 나타나면 그것으로 바꾼다', async () => {
    nativeParts.mockResolvedValueOnce(native({})).mockResolvedValue(native({ status: 'review_required', version: 'v2' }));
    const next = { ...part, version: 'v2' };
    reload.mockResolvedValueOnce([part]).mockResolvedValue([next]);
    const { container, unmount } = await open();
    await rebuild(container);
    await wait(2000);
    expect(replace).not.toHaveBeenCalled();
    await wait(2000);
    await wait(4000);
    expect(replace).toHaveBeenCalledExactlyOnceWith(next);
    expect(container.querySelector('button')?.textContent).not.toContain('다시 만드는 중');
    await unmount();
  });

  it('만들기가 실패하면 그 이유를 보인다', async () => {
    nativeParts.mockResolvedValue(native({ status: 'qc_failed', error: '검수에 실패했습니다.' }));
    const { container, unmount } = await open();
    await rebuild(container);
    await wait(2000);
    expect(container.querySelector('[role=alert]')?.textContent).toBe('검수에 실패했습니다.');
    expect(replace).not.toHaveBeenCalled();
    await unmount();
  });

  it('패널이 닫히면 기다리던 읽기를 멈추고 타이머도 남기지 않는다', async () => {
    nativeParts.mockResolvedValue(native({}));
    const { container, unmount } = await open();
    await rebuild(container);
    await wait(6000);
    expect(nativeParts).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await unmount();
    expect(vi.getTimerCount()).toBe(0);
    await wait(600_000);
    expect(nativeParts).toHaveBeenCalledTimes(3);
    expect(reload).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('읽는 중에 닫혀도 그 요청의 끊는 신호가 켜진다', async () => {
    let signal: AbortSignal | undefined;
    nativeParts.mockImplementation(
      (_id, abort) =>
        new Promise((_done, fail) => {
          signal = abort;
          abort?.addEventListener('abort', () => fail(new Error('cancelled')));
        }),
    );
    const { container, unmount } = await open();
    await rebuild(container);
    await wait(2000);
    expect(signal?.aborted).toBe(false);
    await unmount();
    expect(signal?.aborted).toBe(true);
    await wait(10_000);
    expect(nativeParts).toHaveBeenCalledTimes(1);
  });

  it('옷장 목록을 기다리다 닫혀도 더 읽지 않는다', async () => {
    nativeParts.mockResolvedValue(native({ status: 'review_required', version: 'v2' }));
    reload.mockResolvedValue([part]);
    const { container, unmount } = await open();
    await rebuild(container);
    await wait(2000);
    const asked = reload.mock.calls.length;
    expect(asked).toBeGreaterThan(0);
    await unmount();
    await wait(120_000);
    expect(reload).toHaveBeenCalledTimes(asked);
    expect(replace).not.toHaveBeenCalled();
  });
});
