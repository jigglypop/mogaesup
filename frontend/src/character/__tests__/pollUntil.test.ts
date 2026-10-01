import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pause, pollUntil } from '../studio/poll-until';

describe('기다리며 다시 읽기', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('받아들일 때까지 간격을 두고 읽고 받아들인 값을 준다', async () => {
    const read = vi.fn(async () => (read.mock.calls.length < 3 ? 'wait' : 'done'));
    const result = pollUntil(read, (value) => (value === 'done' ? value.toUpperCase() : undefined), {
      attempts: 10,
      delayMs: 2000,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(result).resolves.toBe('DONE');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('immediate이면 처음 한 번은 기다리지 않고 읽는다', async () => {
    const read = vi.fn(async () => 'found');
    const result = pollUntil(read, (value) => value, { attempts: 3, delayMs: 2000, immediate: true, signal: new AbortController().signal });
    await expect(result).resolves.toBe('found');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('정한 횟수를 넘기면 아무것도 주지 않는다', async () => {
    const read = vi.fn(async () => 'nope');
    const result = pollUntil(read, () => undefined, { attempts: 4, delayMs: 100, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('받아들이는 쪽이 던지면 거기서 끝난다', async () => {
    const result = pollUntil(
      async () => 'failed',
      () => {
        throw new Error('다시 만들지 못했습니다.');
      },
      { attempts: 4, delayMs: 100, signal: new AbortController().signal },
    );
    const caught = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(200);
    await expect(caught).resolves.toMatchObject({ message: '다시 만들지 못했습니다.' });
  });

  it('화면이 닫혀 신호가 끊기면 기다리던 중에도 바로 멈추고 더 읽지 않는다', async () => {
    const controller = new AbortController();
    const read = vi.fn(async () => 'wait');
    const result = pollUntil(read, () => undefined, { attempts: 150, delayMs: 2000, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await expect(result).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('이미 끊긴 신호로는 읽지 않는다', async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn(async () => 'x');
    await expect(pollUntil(read, (value) => value, { attempts: 3, delayMs: 100, immediate: true, signal: controller.signal })).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('pause는 시간이 되거나 신호가 끊기면 끝나고 타이머를 남기지 않는다', async () => {
    const controller = new AbortController();
    let done = false;
    void pause(1000, controller.signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
