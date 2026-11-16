import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { mount } from '../../__tests__/mount';
import { CharacterFactory } from '../factory/CharacterFactory';
import { factoryApi, type FactoryJob, type RigTransferSource } from '../factory/api';
import { RIG_TRANSFER_POLL_MS, RigRecovery } from '../factory/RigRecovery';

// The photo screen around the recovery: one character, the other panels left out.
vi.mock('../use-live-characters', () => {
  const live = { characters: [{ id: 'photo', name: '모개', artifacts: [] }], failure: '', loading: false, refresh: async () => {} };
  return { useLiveCharacters: () => live };
});
vi.mock('../factory/NativeAssembly', () => ({ NativeAssembly: () => null }));
vi.mock('../factory/StageRunner', () => ({ StageRunner: () => null }));
vi.mock('../factory/PartProgress', () => ({ PartProgress: () => null }));
vi.mock('../factory/ProductionProgress', () => ({ ProductionProgress: () => null }));
vi.mock('../studio/MeshyOptionsEditor', () => ({ MeshyOptionsEditor: () => null }));

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

  it('저장된 복구 요청이 다른 탭에서 처리돼 지워졌어도 누르면 새 키가 아니라 그 키로 보낸다', async () => {
    const saved = { key: 'lost-key', input: { source_job_id: 'source-job', source_version: 'v1' } };
    localStorage.setItem('gaesup.rig-transfer:job', JSON.stringify(saved));
    read.mockResolvedValue(transfer({ can_start: true }));
    // The server answers the same key with the recovery it started.
    const started = vi.spyOn(factoryApi, 'startRigTransfer').mockResolvedValue(transfer({ status: 'running', request_key: 'lost-key' }));
    const { container, unmount } = await mount(<RigRecovery jobId="job" />);
    await wait(0);
    const recover = [...container.querySelectorAll('button')].find((item) => item.textContent === '저장된 골격 복구 결과 확인')!;
    localStorage.removeItem('gaesup.rig-transfer:job');
    await act(async () => recover.click());
    await wait(0);
    expect(started).toHaveBeenCalledExactlyOnceWith('job', saved.input, 'lost-key');
    expect(localStorage.getItem('gaesup.rig-transfer:job')).toBeNull();
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

describe('사진으로 전체 생성에서 제작 버전을 바꿀 때 골격 복구', () => {
  const version = (id: string, created_at: string) => ({ id, character_id: 'photo', character_name: '모개', source_sha256: 'a', status: 'complete',
    created_at, production_mode: 'character_parts', progress: { stage: 'complete', message: '' }, artifacts: [] }) as FactoryJob;
  const versions = [version('older', '2026-09-01T00:00:00Z'), version('newer', '2026-09-02T00:00:00Z')];
  const skeletons: RigTransferSource[] = [{ job_id: 'skeleton-a', version: 'v1', name: 'A' }, { job_id: 'skeleton-b', version: 'v1', name: 'B' }];
  /** What each version's recovery answers, in turn; the last answer stays. */
  let answers: Record<string, Transfer[]>;
  let previous: string;
  beforeEach(() => {
    vi.useFakeTimers();
    previous = `${location.pathname}${location.search}`;
    history.replaceState(null, '', '/admin/studio/make/photo');
    vi.spyOn(factoryApi, 'capabilities').mockResolvedValue({ ready: true, image_provider: 'x', image_model: 'x', slots: [], meshy_model: 'x', image_configured: true, meshy_configured: true, blender_available: true, next_actions: [] });
    vi.spyOn(factoryApi, 'detail').mockImplementation(async (id) => versions.find((item) => item.id === id)!);
    vi.spyOn(factoryApi, 'rigTransfer').mockImplementation(async (id) => (answers[id]!.length > 1 ? answers[id]!.shift()! : answers[id]![0]!));
    vi.spyOn(factoryApi, 'rigTransferSources').mockResolvedValue({ items: skeletons });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    history.replaceState(null, '', previous);
    localStorage.clear();
  });
  const open = (refreshJobs: () => Promise<unknown> = async () => {}) =>
    mount(<CharacterFactory jobs={versions} jobsLoading={false} jobsError="" catalogError="" bodyProfileError="" onJob={() => {}} refreshJobs={refreshJobs} />);
  const choose = (container: HTMLElement, id: string) =>
    act(async () => {
      const select = container.querySelector<HTMLSelectElement>('select[aria-label="제작 버전"]')!;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, id);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  const recovery = (container: HTMLElement) => container.querySelector('section[aria-label="저장된 골격 복구"]')!;

  it('앞 버전의 복구가 끝나 있었어도 새 버전의 복구가 끝나면 작업 목록을 다시 읽는다', async () => {
    answers = { newer: [transfer({ status: 'complete' })], older: [transfer({ status: 'running' }), transfer({ status: 'complete' })] };
    const refreshJobs = vi.fn(async () => {});
    const { container, unmount } = await open(refreshJobs);
    await wait(0);
    expect(refreshJobs).toHaveBeenCalledOnce();
    await choose(container, 'older');
    await wait(0);
    expect(recovery(container).textContent).toContain('골격·동작 이전 중');
    await seconds(RIG_TRANSFER_POLL_MS / 1000);
    expect(refreshJobs).toHaveBeenCalledTimes(2);
    await unmount();
  });

  it('앞 버전에서 고른 골격 대신 새 버전의 권장 골격을 고른다', async () => {
    answers = { newer: [transfer({ can_start: true, recommended_source: skeletons[0] })], older: [transfer({ can_start: true, recommended_source: skeletons[1] })] };
    const { container, unmount } = await open();
    await seconds(1);
    expect(recovery(container).querySelector('select')!.value).toBe('skeleton-a:v1');
    await choose(container, 'older');
    await seconds(1);
    expect(recovery(container).querySelector('select')!.value).toBe('skeleton-b:v1');
    expect(recovery(container).querySelector('button')!.textContent).toBe('권장 골격으로 복구 · 유료 작업 포함');
    await unmount();
  });
});
