import { describe, expect, it, vi } from 'vitest';

import { createHeldLoads } from '../studio/held-loads';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((done) => setTimeout(done, 0));

/** Loads that finish when the test says so, one per call. */
function setup() {
  const calls: { input: string; signal: AbortSignal; load: ReturnType<typeof deferred<string>> }[] = [];
  const release = vi.fn<(value: string) => void>();
  const ready = vi.fn<(key: string, value: string) => void>();
  const dropped = vi.fn<(key: string) => void>();
  const held = createHeldLoads<string, string>({
    load: (input, signal) => {
      const load = deferred<string>();
      calls.push({ input, signal, load });
      return load.promise;
    },
    release,
    ready,
    dropped,
  });
  return { calls, release, ready, dropped, held };
}
const wanted = (...keys: string[]) => new Map(keys.map((key) => [key, `input:${key}`]));

describe('키마다 하나씩 불러와 두는 자원', () => {
  it('불러오는 동안 다시 원해도 한 번만 불러온다', async () => {
    const { calls, ready, held } = setup();
    held.want(wanted('a'));
    held.want(wanted('a'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('input:a');
    calls[0]?.load.resolve('mask-a');
    await flush();
    expect(ready).toHaveBeenCalledExactlyOnceWith('a', 'mask-a');
    held.want(wanted('a'));
    expect(calls).toHaveLength(1);
  });

  it('불러오는 중에 필요 없어지면 취소하고, 늦게 도착한 것은 바로 풀어 준다', async () => {
    const { calls, ready, release, held } = setup();
    held.want(wanted('a'));
    held.want(wanted());
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.load.resolve('mask-a');
    await flush();
    expect(release).toHaveBeenCalledExactlyOnceWith('mask-a');
    expect(ready).not.toHaveBeenCalled();
    // 다시 필요해지면 새로 불러온다.
    held.want(wanted('a'));
    expect(calls).toHaveLength(2);
  });

  it('불러오는 중에 목록이 바뀌어도 아직 필요한 것은 이어서 쓴다', async () => {
    const { calls, ready, held } = setup();
    held.want(wanted('a', 'b'));
    held.want(wanted('b', 'c'));
    expect(calls.map((call) => call.input)).toEqual(['input:a', 'input:b', 'input:c']);
    expect(calls.map((call) => call.signal.aborted)).toEqual([true, false, false]);
    calls[1]?.load.resolve('mask-b');
    await flush();
    expect(ready).toHaveBeenCalledExactlyOnceWith('b', 'mask-b');
  });

  it('입지 않게 된 것은 풀고 알리며, 다시 입으면 새로 불러온다', async () => {
    const { calls, release, dropped, held } = setup();
    held.want(wanted('a'));
    calls[0]?.load.resolve('mask-a');
    await flush();
    held.want(wanted('b'));
    expect(release).toHaveBeenCalledExactlyOnceWith('mask-a');
    expect(dropped).toHaveBeenCalledExactlyOnceWith('a');
    held.want(wanted('a', 'b'));
    expect(calls.map((call) => call.input)).toEqual(['input:a', 'input:b', 'input:a']);
  });

  it('실패한 불러오기는 지우고, 다음에 원하면 다시 해 본다', async () => {
    const { calls, ready, release, held } = setup();
    held.want(wanted('a'));
    calls[0]?.load.reject(new Error('no texture'));
    await flush();
    expect(ready).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    held.want(wanted('a'));
    expect(calls).toHaveLength(2);
  });

  it('닫으면 둔 것을 모두 풀고, 불러오던 것은 취소하며, 그 뒤로는 아무것도 하지 않는다', async () => {
    const { calls, ready, release, held } = setup();
    held.want(wanted('a', 'b'));
    calls[0]?.load.resolve('mask-a');
    await flush();
    held.dispose();
    expect(release).toHaveBeenCalledExactlyOnceWith('mask-a');
    expect(calls[1]?.signal.aborted).toBe(true);
    calls[1]?.load.resolve('mask-b');
    await flush();
    expect(release).toHaveBeenLastCalledWith('mask-b');
    expect(ready).toHaveBeenCalledTimes(1);
    held.want(wanted('c'));
    expect(calls).toHaveLength(2);
  });

  it('불러오기 함수가 바로 던져도 실패로 센다', async () => {
    const held = createHeldLoads<string, string>({
      load: () => {
        throw new Error('sync');
      },
      release: vi.fn(),
      ready: vi.fn(),
    });
    expect(() => held.want(wanted('a'))).not.toThrow();
    await flush();
    expect(() => held.want(wanted('a'))).not.toThrow();
  });
});
