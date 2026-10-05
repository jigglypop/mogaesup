import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import type { FactoryJob } from '../factory/api';
import { PartProgress } from '../factory/PartProgress';

const JOB = 'photo-job';
const STORAGE = `gaesup.part-refit:${JOB}`;
const job = {
  id: JOB, assembly_version: 'v2', artifacts: [], next_actions: [],
  parts: [{ slot: 'top', image_status: 'succeeded', model_status: 'ready', part_method: 'isolated' }],
} as unknown as FactoryJob;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === label);

describe('파츠 수신 현황의 피팅 복구', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('응답을 잃은 피팅은 저장된 입력과 키 그대로 다시 보낸다', async () => {
    // Saved from another screen with a fit profile and a shape the button here never builds.
    const saved = { key: 'lost-key', input: { source_version: 'v1', slot: 'top', part_method: 'body_shell', shape: { hem: 0.3 }, fit_profile: { ease: 'loose' } } };
    localStorage.setItem(STORAGE, JSON.stringify(saved));
    fetchMock.mockResolvedValue(json(202, { status: 'accepted', artifacts: [], parts: [] }));
    const { container, unmount } = await mount(<PartProgress job={job} busy={false} retryImage={async () => undefined} />);
    expect(button(container, '기존 모델 위치·크기 맞추기')).toBeUndefined();

    await act(async () => button(container, '같은 피팅 요청 복구')!.click());
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('lost-key');
    expect(JSON.parse(String(init?.body))).toEqual(saved.input);
    expect(container.querySelector('[role=alert]')).toBeNull();
    expect(localStorage.getItem(STORAGE)).toBeNull();
    expect(button(container, '같은 피팅 요청 복구')).toBeUndefined();
    expect(button(container, '기존 모델 위치·크기 맞추기')).toBeDefined();
    await unmount();
  });
});
