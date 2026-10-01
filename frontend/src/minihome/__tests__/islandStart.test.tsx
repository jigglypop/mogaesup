import { act } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mount } from '../../__tests__/mount';
import { StartBanner } from '../edit/EditChrome';
import { useIslandStart } from '../edit/useIslandStart';

/** The island screen's use of the hook: a banner with a retry once the engine failed to start. */
function Harness(props: Parameters<typeof useIslandStart>[0]) {
  const { failed, retry } = useIslandStart(props);
  return failed ? <StartBanner onRetry={retry} /> : <p>열었어요</p>;
}

const flush = () => act(async () => void (await Promise.resolve()));

describe('섬 시작', () => {
  const log = vi.spyOn(console, 'error');
  beforeEach(() => log.mockImplementation(() => {}));
  afterEach(() => log.mockReset());

  const parts = () => ({
    runtime: { setup: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) },
    saver: { load: vi.fn<() => Promise<boolean>>().mockResolvedValue(true) },
    history: { start: vi.fn() },
  });

  it('엔진을 켜고 저장된 섬을 불러온 뒤에 되돌리기를 시작한다', async () => {
    const island = parts();
    const order: string[] = [];
    island.runtime.setup.mockImplementation(async () => void order.push('setup'));
    island.saver.load.mockImplementation(async () => (order.push('load'), true));
    island.history.start.mockImplementation(() => void order.push('history'));
    const { container, unmount } = await mount(<Harness {...island} />);
    await flush();
    expect(order).toEqual(['setup', 'load', 'history']);
    expect(container.querySelector('[role=alert]')).toBeNull();
    await unmount();
  });

  it('불러오지 못했다면 되돌리기를 시작하지 않는다', async () => {
    const island = parts();
    island.saver.load.mockResolvedValue(false);
    const { unmount } = await mount(<Harness {...island} />);
    await flush();
    expect(island.history.start).not.toHaveBeenCalled();
    await unmount();
  });

  it('엔진이 켜지지 않으면 불러오는 중에 머물지 않고 실패와 다시 불러오기를 보인다', async () => {
    const island = parts();
    island.runtime.setup.mockRejectedValueOnce(new Error('engine failed'));
    const { container, unmount } = await mount(<Harness {...island} />);
    await flush();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ message: 'engine failed' }));
    expect(container.querySelector('[role=alert]')?.textContent).toContain('섬을 불러오지 못했어요');
    expect(island.saver.load).not.toHaveBeenCalled();
    expect(island.history.start).not.toHaveBeenCalled();

    await act(async () => container.querySelector('button')!.click());
    await flush();
    expect(island.runtime.setup).toHaveBeenCalledTimes(2);
    expect(island.saver.load).toHaveBeenCalledTimes(1);
    expect(island.history.start).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role=alert]')).toBeNull();
    await unmount();
  });

  it('다시 시도해도 안 되면 다시 실패를 보인다', async () => {
    const island = parts();
    island.runtime.setup.mockRejectedValue(new Error('still failing'));
    const { container, unmount } = await mount(<Harness {...island} />);
    await flush();
    await act(async () => container.querySelector('button')!.click());
    await flush();
    expect(island.runtime.setup).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role=alert]')).not.toBeNull();
    await unmount();
  });

  it('섬을 떠난 뒤에는 불러오지도 시작하지도 않고 실패를 알리지도 않는다', async () => {
    const island = parts();
    let finishSetup!: () => void;
    island.runtime.setup.mockImplementationOnce(() => new Promise<void>((done) => (finishSetup = done)));
    const { unmount } = await mount(<Harness {...island} />);
    await unmount();
    finishSetup();
    await flush();
    expect(island.saver.load).not.toHaveBeenCalled();
    expect(island.history.start).not.toHaveBeenCalled();
  });
});
