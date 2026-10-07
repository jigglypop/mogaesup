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

  it('복구는 유료 작업이 포함된다고 보이고, 서버가 아니라고 할 때만 그 표시를 뺀다', async () => {
    vi.mocked(factoryApi.rigTransferSources).mockResolvedValue({ items: [{ job_id: 'source-job', version: 'v1', name: '기준' }] });
    read.mockResolvedValue(transfer({ can_start: true }));
    const { container, unmount } = await mount(<RigRecovery jobId="job" />);
    await wait(0); await wait(0);
    const start = () => [...container.querySelectorAll('button')].find((item) => item.textContent?.startsWith('선택한 골격으로 복구'));
    expect(start()?.textContent).toBe('선택한 골격으로 복구 · 유료 작업 포함');
    expect(container.textContent).not.toContain('유료 생성 없음');
    await unmount();

    read.mockResolvedValue(transfer({ can_start: true, paid: false }));
    const free = await mount(<RigRecovery jobId="job" />);
    await wait(0); await wait(0);
    expect([...free.container.querySelectorAll('button')].some((item) => item.textContent === '선택한 골격으로 복구')).toBe(true);
    await free.unmount();
  });

  it('다른 작업으로 바뀌면 앞 작업에서 고른 골격을 들고 가지 않는다', async () => {
    const items = [{ job_id: 'a-job', version: 'v1', name: '골격 A' }, { job_id: 'b-job', version: 'v1', name: '골격 B' }];
    vi.mocked(factoryApi.rigTransferSources).mockResolvedValue({ items });
    read.mockResolvedValue(transfer({ can_start: true }));
    const { container, rerender, unmount } = await mount(<RigRecovery jobId="first" />);
    await wait(0); await wait(0);
    const select = () => container.querySelector('select')!;
    await act(async () => {
      select().value = 'b-job:v1';
      select().dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select().value).toBe('b-job:v1');
    await rerender(<RigRecovery jobId="second" />);
    await wait(0); await wait(0);
    expect(select().value).toBe('a-job:v1');
    await unmount();
  });

  it('저장된 복구 요청이 다른 탭에서 처리됐으면 누르더라도 접수하지 않는다', async () => {
    localStorage.setItem('gaesup.rig-transfer:job', JSON.stringify({ key: 'lost-key', input: { source_job_id: 'source-job', source_version: 'v1' } }));
    read.mockResolvedValue(transfer({ can_start: true }));
    const started = vi.spyOn(factoryApi, 'startRigTransfer');
    const { container, unmount } = await mount(<RigRecovery jobId="job" />);
    await wait(0);
    const recover = [...container.querySelectorAll('button')].find((item) => item.textContent === '저장된 골격 복구 결과 확인')!;
    localStorage.removeItem('gaesup.rig-transfer:job');
    await act(async () => recover.click());
    await wait(0);
    expect(started).not.toHaveBeenCalled();
    expect([...container.querySelectorAll('button')].some((item) => item.textContent === '저장된 골격 복구 결과 확인')).toBe(false);
    await unmount();
  });

  it('새 복구를 누를 때 다른 탭이 방금 저장한 요청이 있으면 새 키로 덮어쓰지 않고 그 요청을 그 키로 보낸다', async () => {
    vi.mocked(factoryApi.rigTransferSources).mockResolvedValue({ items: [{ job_id: 'source-job', version: 'v1', name: '기준' }] });
    read.mockResolvedValue(transfer({ can_start: true }));
    const started = vi.spyOn(factoryApi, 'startRigTransfer').mockResolvedValue(transfer({ status: 'accepted', request_key: 'other-tab-key' }));
    const { container, unmount } = await mount(<RigRecovery jobId="job" />);
    await wait(0); await wait(0);
    const start = [...container.querySelectorAll('button')].find((item) => item.textContent?.startsWith('선택한 골격으로 복구'))!;
    // Saved by another tab after this one was drawn; this tab has not heard of it yet.
    const other = { key: 'other-tab-key', input: { source_job_id: 'other-job', source_version: 'v2' } };
    localStorage.setItem('gaesup.rig-transfer:job', JSON.stringify(other));
    await act(async () => start.click());
    await wait(0);
    expect(started).toHaveBeenCalledExactlyOnceWith('job', other.input, 'other-tab-key');
    expect(JSON.parse(localStorage.getItem('gaesup.rig-transfer:job')!)).toEqual(other);
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
