import { act } from 'react';

import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { factoryApi } from '../factory/api';
import { studioApi } from '../studio/api';
import { ExpressionGenerationPanel } from '../studio/ExpressionGeneration';
import { expressionGenerationApi, type ExpressionGeneration } from '../studio/expression-generation-api';
import { generationsInterval, type Generation } from '../studio/generations-api';
import { HairBatch } from '../studio/HairBatch';
import { hairBatchesApi, type HairBatch as HairBatchRecord } from '../studio/hair-batches-api';
import { Workspace } from '../studio/Workspace';

vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: null, status: 'signedIn' }) }));

const seconds = (count: number) => act(async () => { await vi.advanceTimersByTimeAsync(count * 1000); });
const generation = (status: Generation['status']) => ({ id: status, status } as Generation);

describe('진행 중일 때만 자주 읽기', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('기물·원화 목록은 만드는 중인 것이 있을 때만 5초마다 읽는다', () => {
    expect(generationsInterval({ items: [generation('complete'), generation('blocked')] })).toBe(30000);
    expect(generationsInterval({ items: [generation('complete'), generation('running')] })).toBe(5000);
    expect(generationsInterval({ items: [generation('accepted')] })).toBe(5000);
    expect(generationsInterval(undefined)).toBe(30000);
  });

  it('헤어 배치 목록은 처리 중인 배치가 있을 때만 5초마다 읽는다', async () => {
    const batch = (status: string) => ({ id: status, status, completed: 0, created_at: '2026-10-06T00:00:00Z', items: [],
      input: { base_job_id: 'b', base_version: 'v1', items: [], concurrency: 1, meshy_options: {} } } as unknown as HairBatchRecord);
    const list = vi.spyOn(hairBatchesApi, 'list').mockResolvedValue({ items: [batch('complete')] });
    const { unmount } = await mount(<HairBatch baseId="b" version="v1" disabled={false} onJob={() => {}} />);
    await seconds(0);
    expect(list).toHaveBeenCalledOnce();
    await seconds(20);
    expect(list).toHaveBeenCalledOnce();
    list.mockResolvedValue({ items: [batch('running')] });
    await seconds(10);
    expect(list).toHaveBeenCalledTimes(2);
    await seconds(5);
    expect(list).toHaveBeenCalledTimes(3);
    await unmount();
  });

  it('표정 텍스처 목록은 만드는 중인 것이 있을 때만 5초마다 읽는다', async () => {
    const listing = (status?: ExpressionGeneration['status']) => ({
      items: status ? [{ id: 'g', request_key: 'k', status, name: 'smile', artifacts: [] } as unknown as ExpressionGeneration] : [],
      capabilities: { ready: true, reason: null }, defaults: { neutral: 'n' } as never, reference: { revision: '0', assets: [] }, batches: [],
    });
    const list = vi.spyOn(expressionGenerationApi, 'list').mockResolvedValue(listing());
    const { unmount } = await mount(<ExpressionGenerationPanel job="job" version="v1" ready onApply={async () => {}} />);
    await seconds(0);
    await seconds(20);
    expect(list).toHaveBeenCalledOnce();
    list.mockResolvedValue(listing('running'));
    await seconds(10);
    expect(list).toHaveBeenCalledTimes(2);
    await seconds(5);
    expect(list).toHaveBeenCalledTimes(3);
    await unmount();
  });
});

describe('작업 공간이 읽는 목록', () => {
  let previous: string;
  beforeEach(() => {
    previous = `${location.pathname}${location.search}`;
    vi.spyOn(factoryApi, 'list').mockResolvedValue({ jobs: [] });
    vi.spyOn(factoryApi, 'bodyProfile').mockResolvedValue({ revision: '1', body: null });
    vi.spyOn(studioApi, 'catalog').mockResolvedValue({ revision: '1', items: {}, parts: {} });
    vi.spyOn(studioApi, 'textures').mockResolvedValue({ items: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    history.replaceState(null, '', previous);
  });

  it('작업 목록·카탈로그·공통 몸을 보이지 않는 화면은 그것들을 읽지 않는다', async () => {
    history.replaceState(null, '', '/admin/studio/textures?tab=textures');
    const { unmount } = await mount(<MemoryRouter><Workspace /></MemoryRouter>);
    await act(async () => { for (let round = 0; round < 10; round++) await Promise.resolve(); });
    expect(factoryApi.list).not.toHaveBeenCalled();
    expect(studioApi.catalog).not.toHaveBeenCalled();
    expect(factoryApi.bodyProfile).not.toHaveBeenCalled();
    await unmount();
  });

  it('관리자페이지는 셋 다 읽는다', async () => {
    history.replaceState(null, '', '/admin/studio/library?tab=admin');
    const { unmount } = await mount(<MemoryRouter><Workspace /></MemoryRouter>);
    await act(async () => { await Promise.resolve(); });
    expect(factoryApi.list).toHaveBeenCalledOnce();
    expect(studioApi.catalog).toHaveBeenCalledOnce();
    expect(factoryApi.bodyProfile).toHaveBeenCalledOnce();
    await unmount();
  });
});
