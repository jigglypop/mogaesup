import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../api/client';
import { catalogApi } from '../../api/endpoints';
import { mount } from '../../__tests__/mount';
import { POWER_READ_TRIES, StudioPowerLine, WakeBanner } from '../StudioPower';

const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
/** Time passing as it does in the page: the screen renders between ticks. */
const minutes = async (count: number) => {
  for (let tick = 0; tick < count * 6; tick++) await wait(10_000);
};
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === label);

describe('스튜디오 켜는 중 안내', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('알림 영역은 문장만 읽고 매초 바뀌는 경과 시간은 읽지 않는다', async () => {
    const { container, unmount } = await mount(<WakeBanner sleep={{ code: 'studio_waking', message: '스튜디오를 켜는 중이에요.', since: Date.now() }} />);
    await wait(3000);
    const region = container.querySelector('[role=status]')!;
    expect(region.querySelector('b')?.textContent).toBe('스튜디오를 켜는 중이에요.');
    const clock = region.querySelector('small')!;
    expect(clock.textContent).toBe('0:03');
    expect(clock.getAttribute('aria-hidden')).toBe('true');
    await unmount();
  });
});

describe('스튜디오 전원 줄', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const refused = () => new ApiRequestError(502, 'factory_unavailable', '캐릭터 서버에 연결하지 못했습니다.');

  it('처음 읽기가 실패하면 그 이유와 다시 확인을 보이고, 몇 번 실패하면 저절로 묻기를 멈춘다', async () => {
    const power = vi.spyOn(catalogApi, 'studioPower').mockRejectedValue(refused());
    const { container, unmount } = await mount(<StudioPowerLine canStart />);
    await wait(0);
    expect(container.querySelector('[role=alert]')?.textContent).toContain('스튜디오 상태를 읽지 못함');
    expect(container.textContent).toContain('캐릭터 서버에 연결하지 못했습니다.');
    expect(button(container, '다시 확인')).toBeDefined();
    await minutes(2);
    expect(power).toHaveBeenCalledTimes(POWER_READ_TRIES);

    power.mockResolvedValue({ configured: true, instanceId: 'i-1', state: 'stopped' });
    await act(async () => button(container, '다시 확인')!.click());
    await wait(0);
    expect(power).toHaveBeenCalledTimes(POWER_READ_TRIES + 1);
    expect(container.textContent).toContain('스튜디오 꺼짐');
    expect(container.textContent).not.toContain('읽지 못함');
    expect(button(container, '스튜디오 켜기')).toBeDefined();
    await unmount();
  });

  it('켜지는 중에 읽기가 실패해도 실패를 보이며 정해진 횟수까지만 다시 묻는다', async () => {
    const power = vi.spyOn(catalogApi, 'studioPower').mockResolvedValueOnce({ configured: true, instanceId: 'i-1', state: 'pending' }).mockRejectedValue(refused());
    const { container, unmount } = await mount(<StudioPowerLine />);
    await wait(0);
    expect(container.textContent).toContain('스튜디오 켜는 중');
    await minutes(2);
    expect(power).toHaveBeenCalledTimes(1 + POWER_READ_TRIES);
    expect(container.textContent).toContain('캐릭터 서버에 연결하지 못했습니다.');
    expect(button(container, '다시 확인')).toBeDefined();
    await unmount();
  });

  it('켤 권한이 없으면 꺼진 상태만 보이고 켜기 버튼은 없다', async () => {
    vi.spyOn(catalogApi, 'studioPower').mockResolvedValue({ configured: true, instanceId: 'i-1', state: 'stopped' });
    const { container, unmount } = await mount(<StudioPowerLine />);
    await wait(0);
    expect(container.textContent).toContain('스튜디오 꺼짐');
    expect(button(container, '스튜디오 켜기')).toBeUndefined();
    await unmount();
  });

  it('이 서버가 전원을 다루지 않으면 아무것도 보이지 않는다', async () => {
    vi.spyOn(catalogApi, 'studioPower').mockResolvedValue({ configured: false });
    const { container, unmount } = await mount(<StudioPowerLine />);
    await wait(0);
    expect(container.textContent).toBe('');
    await unmount();
  });
});
