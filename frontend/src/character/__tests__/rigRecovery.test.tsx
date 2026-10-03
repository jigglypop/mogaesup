import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { mount } from '../../__tests__/mount';
import { factoryApi } from '../factory/api';
import { RIG_TRANSFER_POLL_MS, RigRecovery } from '../factory/RigRecovery';

type Transfer = Awaited<ReturnType<typeof factoryApi.rigTransfer>>;
const transfer = (changes: Partial<Transfer>): Transfer => ({ status: 'not_started', can_start: false, ...changes });
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
/** Time passing as it does in the page: the screen renders between ticks. */
const seconds = async (count: number) => {
  for (let tick = 0; tick < count; tick++) await wait(1000);
};
const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('저장된 골격 복구 상태 읽기', () => {
  let read: MockInstance<typeof factoryApi.rigTransfer>;
  beforeEach(() => {
    vi.useFakeTimers();
    read = vi.spyOn(factoryApi, 'rigTransfer');
    vi.spyOn(factoryApi, 'rigTransferSources').mockResolvedValue({ items: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, 'hidden');
    localStorage.clear();
  });

  it('진행 중인 복구가 없으면 처음 한 번만 읽는다', async () => {
    read.mockResolvedValue(transfer({}));
    const { unmount } = await mount(<RigRecovery jobId="job" />);
    await seconds(60);
    expect(read).toHaveBeenCalledOnce();
    await unmount();
  });

  it('진행 중인 동안만 5초마다 읽고, 끝나면 멈추고 알린다', async () => {
    read.mockResolvedValueOnce(transfer({ status: 'running' })).mockResolvedValueOnce(transfer({ status: 'running' })).mockResolvedValue(transfer({ status: 'complete' }));
    const complete = vi.fn();
    const { container, unmount } = await mount(<RigRecovery jobId="job" onComplete={complete} />);
    await wait(0);
    expect(container.textContent).toContain('골격·동작 이전 중');
    await seconds(RIG_TRANSFER_POLL_MS / 1000 * 2);
    expect(read).toHaveBeenCalledTimes(3);
    expect(complete).toHaveBeenCalledOnce();
    await seconds(60);
    expect(read).toHaveBeenCalledTimes(3);
    await unmount();
  });

  it('탭이 가려진 동안은 진행 중이어도 읽지 않고, 다시 보이면 읽는다', async () => {
    read.mockResolvedValue(transfer({ status: 'accepted' }));
    const { unmount } = await mount(<RigRecovery jobId="job" />);
    await wait(0);
    expect(read).toHaveBeenCalledOnce();
    setHidden(true);
    await seconds(30);
    expect(read).toHaveBeenCalledOnce();
    await act(async () => setHidden(false));
    await wait(0);
    expect(read).toHaveBeenCalledTimes(2);
    await unmount();
  });

  it('속한 작업이 바뀌었다고 알려 오면 한 번 다시 읽는다', async () => {
    read.mockResolvedValue(transfer({}));
    const { rerender, unmount } = await mount(<RigRecovery jobId="job" refreshKey="running:1" />);
    await wait(0);
    await rerender(<RigRecovery jobId="job" refreshKey="running:1" />);
    await wait(0);
    expect(read).toHaveBeenCalledOnce();
    await rerender(<RigRecovery jobId="job" refreshKey="failed:2" />);
    await wait(0);
    expect(read).toHaveBeenCalledTimes(2);
    await unmount();
  });

  it('읽지 못하면 다시 확인할 수 있다', async () => {
    read.mockRejectedValueOnce(new Error('복구 상태를 읽지 못했습니다.')).mockResolvedValue(transfer({}));
    const { container, unmount } = await mount(<RigRecovery jobId="job" />);
    await wait(0);
    expect(container.querySelector('[role=alert]')?.textContent).toBe('복구 상태를 읽지 못했습니다.');
    await act(async () => container.querySelector('button')!.click());
    await wait(0);
    expect(read).toHaveBeenCalledTimes(2);
    await unmount();
  });
});
