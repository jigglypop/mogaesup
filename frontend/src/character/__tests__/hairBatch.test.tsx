import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { HairBatch } from '../studio/HairBatch';
import { hairBatchesApi, type HairBatchInput } from '../studio/hair-batches-api';
import { meshyDefaultsFor } from '../studio/meshy-options';

const PENDING = 'gaesup.hair-batch.pending.v1';
const DRAFT = 'gaesup.hair-batch.draft.v1';
const views = { front: 'a'.repeat(64), side: 'b'.repeat(64), back: 'c'.repeat(64) };
const input = (name: string): HairBatchInput => ({
  base_job_id: 'base-job', base_version: 'v1', items: [{ name, views }], concurrency: 4, meshy_options: meshyDefaultsFor('hair'),
  redraw: { notes: '', source_side_facing: 'right', worn: true },
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const settle = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent?.startsWith(text));

describe('헤어 일괄 생성의 저장된 요청', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(hairBatchesApi, 'list').mockResolvedValue({ items: [] });
    // One cut style chosen in an earlier visit, ready to send.
    localStorage.setItem(DRAFT, JSON.stringify({ mode: 'multi', source: null, rows: 1, columns: 1, layout: 'equal', order: ['front', 'back', 'side'],
      removeSkin: false, items: [{ name: '새 머리', views, row: 1, column: 1 }], selected: [0], redrawNotes: '', sourceSideFacing: 'right', worn: true }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
    localStorage.clear();
  });
  const open = async () => {
    const mounted = await mount(<HairBatch baseId="base-job" version="v1" disabled={false} onJob={() => {}} />);
    await settle();
    return mounted;
  };

  it('남은 요청을 보이고, 지우면 새 배치를 보낼 수 있다', async () => {
    localStorage.setItem(PENDING, JSON.stringify({ key: 'lost-key', input: input('단발') }));
    const { container, unmount } = await open();
    expect(container.querySelector('.generation-recovery')?.textContent).toContain('응답을 확인하지 못한 배치 · 단발');
    expect(button(container, '같은 요청 키로 접수 복구')).toBeDefined();
    await act(async () => button(container, '저장된 요청 지우기')!.click());
    expect(localStorage.getItem(PENDING)).toBeNull();
    expect(container.querySelector('.generation-recovery')).toBeNull();
    expect(button(container, '1종 생성')?.disabled).toBe(false);
    await unmount();
  });

  it('화면이 본 뒤 다른 곳에서 저장된 요청을 지금 입력 대신 보내지 않고, 그 요청을 이어서 보낼 수 있게 한다', async () => {
    const { container, unmount } = await open();
    expect(container.querySelector('.generation-recovery')).toBeNull();
    // Another tab lost the answer for its own batch after this screen rendered.
    localStorage.setItem(PENDING, JSON.stringify({ key: 'other-tab-key', input: input('단발') }));
    await act(async () => button(container, '1종 생성')!.click());
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('[role=alert]')?.textContent).toBe('응답을 확인하지 못한 다른 요청이 남아 있습니다.');
    expect(container.querySelector('.generation-recovery')?.textContent).toContain('단발');

    fetchMock.mockResolvedValueOnce(json(200, { id: 'batch-1', status: 'accepted', completed: 0, created_at: '2026-10-02T00:00:00Z', input: input('단발'), items: [] }));
    await act(async () => button(container, '같은 요청 키로 접수 복구')!.click());
    await settle();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Idempotency-Key')).toBe('other-tab-key');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).items[0].name).toBe('단발');
    expect(localStorage.getItem(PENDING)).toBeNull();
    await unmount();
  });
});
