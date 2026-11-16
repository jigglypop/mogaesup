import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { mount } from '../../__tests__/mount';
import { factoryApi } from '../factory/api';
import { StageRunner } from '../factory/StageRunner';

type Stages = Awaited<ReturnType<typeof factoryApi.stages>>;
const STORAGE = 'gaesup.factory.stage:job';
const stages: Stages = {
  busy: false, recommended_stage: 'assemble', operation: null,
  actions: [{ stage: 'images', enabled: true, reason: null, paid: true }, { stage: 'assemble', enabled: true, reason: null, paid: false }],
  saved: { images: 0, images_total: 18, models: 0, models_total: 6, rig: false },
};
const stored = () => JSON.parse(localStorage.getItem(STORAGE) ?? 'null') as { stage: string; key: string } | null;
const button = (container: HTMLElement, text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === text);
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

describe('단계부터 실행', () => {
  let resume: MockInstance<typeof factoryApi.resumeStage>;
  beforeEach(() => {
    vi.spyOn(factoryApi, 'stages').mockResolvedValue(stages);
    resume = vi.spyOn(factoryApi, 'resumeStage').mockResolvedValue({ ...stages, busy: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('다른 탭이 저장한 단계 요청이 있으면 누른 단계 대신 그것을 보내지 않고, 그 요청을 복구하게 한다', async () => {
    const { container, unmount } = await mount(<StageRunner jobId="job" onChange={() => {}} />);
    await settle();
    localStorage.setItem(STORAGE, JSON.stringify({ stage: 'images', key: 'other-tab' }));
    await act(async () => button(container, '피팅·조립부터 실행')!.click());
    expect(resume).not.toHaveBeenCalled();
    expect(container.querySelector('[role=alert]')?.textContent).toBe('응답을 확인하지 못한 다른 요청이 남아 있습니다.');
    expect(button(container, '피팅·조립부터 실행')!.disabled).toBe(true);
    expect(stored()).toEqual({ stage: 'images', key: 'other-tab' });
    await act(async () => button(container, '이미지 실행 응답 복구')!.click());
    expect(resume).toHaveBeenCalledExactlyOnceWith('job', 'images', 'other-tab');
    expect(stored()).toBeNull();
    await unmount();
  });
});
