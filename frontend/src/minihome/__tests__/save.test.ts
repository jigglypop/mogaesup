import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError, ApiTimeoutError } from '../../api/client';
import { createIslandSaver, describeSaveError, describeStatus, retryable, savesLater, type SaveProblem } from '../edit/save';
import { IslandTooLargeError } from '../persistence';
import { fakeWorld, ready } from './fakeWorld';

describe('island saver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('불러오기 전에는 저장하지 않고, 불러온 섬은 저장할 것이 없다', async () => {
    const world = fakeWorld();
    const saver = createIslandSaver({ system: world.system, adapter: world.adapter, writable: true });
    expect(await saver.save()).toBe(false);
    await saver.load();
    expect(saver.getState()).toMatchObject({ phase: 'ready', dirty: false });
    expect(await saver.flush()).toBe(true);
    expect(world.system.save).not.toHaveBeenCalled();
  });

  it('바뀌면 손을 멈춘 뒤 자동 저장하고, 계속 바뀌어도 최대 대기 안에 저장한다', async () => {
    const world = fakeWorld();
    const saver = await ready(world, { idleMs: 10_000, maxWaitMs: 60_000 });
    world.edit();
    saver.changed();
    expect(saver.getState().dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(world.system.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(world.system.save).toHaveBeenCalledTimes(1);
    expect(saver.getState()).toMatchObject({ dirty: false, saving: false, bytes: 1234 });
    expect(saver.getState().lastSavedAt).not.toBeNull();

    for (let second = 0; second < 60; second += 5) {
      world.edit();
      saver.changed();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(world.system.save).toHaveBeenCalledTimes(2);
  });

  it('섬 밖의 변화(대화로 바뀐 기록)도 저장할 것으로 센다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.edit('gameplay-events');
    saver.changed();
    expect(saver.getState().dirty).toBe(true);
  });

  it('충돌하면 편집을 남긴 채 자동 저장을 멈추고, 덮어쓰기는 최신 리비전을 읽고 저장한다', async () => {
    const world = fakeWorld();
    const saver = await ready(world, { idleMs: 1_000 });
    world.answers.push(new ApiRequestError(409, 'revision_conflict', '다른 곳에서 먼저 저장했어요.'));
    world.edit();
    expect(await saver.save()).toBe(false);
    expect(saver.getState()).toMatchObject({ conflict: true, dirty: true });

    world.edit();
    saver.changed();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(world.system.save).toHaveBeenCalledTimes(1);

    expect(await saver.overwrite()).toBe(true);
    expect(world.adapter.refreshRevision).toHaveBeenCalledTimes(1);
    expect(saver.getState()).toMatchObject({ conflict: false, dirty: false });

    world.edit();
    saver.changed();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(world.system.save).toHaveBeenCalledTimes(3);
  });

  it('최신 섬 불러오기는 편집을 버리고 저장된 섬을 기준으로 삼는다', async () => {
    const world = fakeWorld();
    const saver = await ready(world);
    world.answers.push(new ApiRequestError(409, 'revision_conflict', ''));
    world.edit();
    await saver.save();
    expect(await saver.reloadLatest()).toBe(true);
    expect(world.system.load).toHaveBeenCalledTimes(2);
    expect(saver.getState()).toMatchObject({ phase: 'ready', conflict: false, dirty: false, problem: null });
  });

  it('너무 큰 섬은 같은 모습으로 다시 보내지 않고, 바뀌면 다시 저장해 본다', async () => {
    const world = fakeWorld();
    const saver = await ready(world, { idleMs: 1_000 });
    world.answers.push(new IslandTooLargeError(3 * 1024 * 1024));
    world.edit();
    await saver.save();
    expect(saver.getState().problem?.kind).toBe('tooLarge');
    expect(saver.getState().problem?.message).toContain('3.0MB');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await saver.flush()).toBe(false);
    expect(world.system.save).toHaveBeenCalledTimes(1);

    world.edit();
    saver.changed();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(world.system.save).toHaveBeenCalledTimes(2);
    expect(saver.getState().problem).toBeNull();
  });

  it('400·404처럼 같은 섬으로는 몇 번을 보내도 거절될 실패는 문제만 보이고 다시 보내지 않다가, 섬이 바뀌면 다시 저장해 본다', async () => {
    for (const status of [400, 404]) {
      const world = fakeWorld();
      const saver = await ready(world, { idleMs: 1_000 });
      world.answers.push(new ApiRequestError(status, 'http_error', `요청이 실패했어요 (${status})`));
      world.edit();
      await saver.save();
      expect(saver.getState().problem).toMatchObject({ kind: 'invalid' });
      expect(saver.getState().problem?.message).toContain(`(${status})`);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(await saver.flush()).toBe(false);
      expect(world.system.save).toHaveBeenCalledTimes(1);

      world.edit();
      saver.changed();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(world.system.save).toHaveBeenCalledTimes(2);
      expect(saver.getState().problem).toBeNull();
    }
  });

  it('408·429·5xx는 서버 쪽 사정이라 잠시 뒤 다시 저장한다', async () => {
    for (const status of [408, 429, 500, 502]) {
      const world = fakeWorld();
      const saver = await ready(world, { retryMs: [3_000] });
      world.answers.push(new ApiRequestError(status, 'http_error', ''));
      world.edit();
      await saver.save();
      expect(saver.getState().problem).toMatchObject({ kind: 'server' });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(world.system.save).toHaveBeenCalledTimes(2);
      expect(saver.getState()).toMatchObject({ problem: null, dirty: false });
    }
  });

  it('로그인이 풀려 거절되면 자동 저장을 멈추고 편집을 둔 채 기다리다, 다시 로그인한 뒤 flush하면 저장한다', async () => {
    const world = fakeWorld();
    const saver = await ready(world, { idleMs: 1_000, retryMs: [3_000] });
    world.answers.push(new ApiRequestError(401, 'login_required', '로그인이 필요합니다.'));
    world.edit();
    saver.changed();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saver.getState().problem).toMatchObject({ kind: 'session' });
    // Every save before the owner signs in again would be refused the same way, so none is sent.
    world.edit();
    saver.changed();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(world.system.save).toHaveBeenCalledTimes(1);
    expect(saver.getState()).toMatchObject({ dirty: true });

    expect(await saver.flush()).toBe(true);
    expect(world.system.save).toHaveBeenCalledTimes(2);
    expect(saver.getState()).toMatchObject({ problem: null, dirty: false });
  });

  it('연결이 끊겨 실패하면 잠시 뒤 다시 저장한다', async () => {
    const world = fakeWorld();
    const saver = await ready(world, { retryMs: [3_000] });
    world.answers.push(new TypeError('Failed to fetch'));
    world.edit();
    await saver.save();
    expect(saver.getState().problem?.kind).toBe('network');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(world.system.save).toHaveBeenCalledTimes(2);
    expect(saver.getState()).toMatchObject({ problem: null, dirty: false });
  });

  describe('저장이 계속 실패할 때', () => {
    const offline = () => new TypeError('Failed to fetch');
    /** Edits at the start, and every 5 s after it while `keepEditing`; the seconds at which the saver tried to write. */
    const offlineFor = async (
      world: ReturnType<typeof fakeWorld>,
      saver: Awaited<ReturnType<typeof ready>>,
      seconds: number,
      keepEditing: boolean,
    ) => {
      const tries: number[] = [];
      const start = Date.now();
      world.system.save.mockImplementation(async () => {
        tries.push(Math.round((Date.now() - start) / 1000));
        throw offline();
      });
      for (let second = 0; second < seconds; second += 5) {
        if (keepEditing || second === 0) {
          world.edit();
          saver.changed();
        }
        await vi.advanceTimersByTimeAsync(5_000);
      }
      return tries;
    };

    it('10·30·60·120초 뒤에 다시 시도하고, 그 뒤로는 120초마다 한다', async () => {
      const world = fakeWorld();
      const saver = await ready(world);
      expect(await offlineFor(world, saver, 600, false)).toEqual([10, 20, 50, 110, 230, 350, 470, 590]);
    });

    it('계속 꾸미는 중이라 해도 같은 간격이고, 첫 시도만 최대 대기 시간(60초)에 맞춰진다', async () => {
      const world = fakeWorld();
      const saver = await ready(world);
      expect(await offlineFor(world, saver, 600, true)).toEqual([60, 70, 100, 160, 280, 400, 520]);
    });

    it('연결이 300초 끊겨 있어도 시도는 몇 번 안 된다', async () => {
      const world = fakeWorld();
      const saver = await ready(world);
      const tries = await offlineFor(world, saver, 300, true);
      expect(tries.length).toBeLessThanOrEqual(5);
      expect(saver.getState()).toMatchObject({ dirty: true, saving: false });
      expect(saver.getState().problem?.kind).toBe('network');
    });

    it('기다리는 동안 편집해도 기다림이 줄지 않는다', async () => {
      const world = fakeWorld();
      const saver = await ready(world);
      world.failing.with = offline();
      world.edit();
      saver.changed();
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(world.system.save).toHaveBeenCalledTimes(2);
      // The next try is 30 s after the second: 편집은 다음 시도를 앞당기지 못한다.
      await vi.advanceTimersByTimeAsync(1_000);
      world.edit();
      saver.changed();
      await vi.advanceTimersByTimeAsync(28_999);
      expect(world.system.save).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(world.system.save).toHaveBeenCalledTimes(3);
    });

    it('저장에 성공하면 기다리는 시간이 처음으로 돌아간다', async () => {
      const world = fakeWorld();
      const saver = await ready(world);
      world.answers.push(offline(), offline());
      world.edit();
      saver.changed();
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(world.system.save).toHaveBeenCalledTimes(3);
      expect(saver.getState()).toMatchObject({ dirty: false, problem: null });

      world.failing.with = offline();
      world.edit();
      saver.changed();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(world.system.save).toHaveBeenCalledTimes(4);
      // 처음의 10초다. 30초가 아니다.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(world.system.save).toHaveBeenCalledTimes(5);
    });

    it('나가거나 저장 버튼을 누르면 기다리지 않고 바로 저장하고, 또 실패하면 다음 간격으로 간다', async () => {
      const world = fakeWorld();
      const saver = await ready(world);
      world.failing.with = offline();
      world.edit();
      saver.changed();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(world.system.save).toHaveBeenCalledTimes(1);

      expect(await saver.flush()).toBe(false);
      expect(world.system.save).toHaveBeenCalledTimes(2);
      // 두 번 실패했으니 다음은 30초 뒤다. 처음 10초 타이머는 남지 않는다.
      await vi.advanceTimersByTimeAsync(29_999);
      expect(world.system.save).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(world.system.save).toHaveBeenCalledTimes(3);

      world.failing.with = null;
      expect(await saver.flush()).toBe(true);
      expect(world.system.save).toHaveBeenCalledTimes(4);
      expect(saver.getState()).toMatchObject({ dirty: false, problem: null });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(world.system.save).toHaveBeenCalledTimes(4);
    });

    it('시간 초과도 연결이 끊긴 것처럼 다시 시도한다', async () => {
      const world = fakeWorld();
      const saver = await ready(world, { retryMs: [3_000] });
      world.answers.push(new ApiTimeoutError(60_000));
      world.edit();
      await saver.save();
      expect(saver.getState().problem).toMatchObject({ kind: 'network' });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(world.system.save).toHaveBeenCalledTimes(2);
      expect(saver.getState()).toMatchObject({ problem: null, dirty: false });
    });

    it('고쳐야 하는 실패 뒤의 첫 편집은 이미 오래 기다린 것으로 치지 않는다', async () => {
      const world = fakeWorld();
      const saver = await ready(world, { idleMs: 10_000, maxWaitMs: 30_000 });
      world.answers.push(new IslandTooLargeError(3 * 1024 * 1024));
      world.edit();
      saver.changed();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(world.system.save).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(world.system.save).toHaveBeenCalledTimes(1);

      world.edit();
      saver.changed();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(world.system.save).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(world.system.save).toHaveBeenCalledTimes(2);
    });
  });

  describe('불러오기', () => {
    it('저장된 섬이 있는데 불러오기가 적용되지 않았다면 불러오지 못한 것으로 보고 그 위에 저장하지 않는다', async () => {
      const world = fakeWorld();
      world.adapter.revision = 4;
      world.system.load.mockResolvedValueOnce(false);
      const saver = createIslandSaver({ system: world.system, adapter: world.adapter, writable: true });
      expect(await saver.load()).toBe(false);
      expect(saver.getState()).toMatchObject({ phase: 'loadFailed' });
      expect(saver.getState().problem?.message).toContain('불러오지 못했어요');

      world.edit();
      saver.changed();
      expect(await saver.save()).toBe(false);
      expect(await saver.flush()).toBe(false);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(world.system.save).not.toHaveBeenCalled();

      expect(await saver.load()).toBe(true);
      expect(saver.getState()).toMatchObject({ phase: 'ready', problem: null, dirty: false });
    });

    it('저장된 것이 없는 섬은 불러오기가 false여도 새 섬으로 시작한다', async () => {
      const world = fakeWorld();
      world.adapter.revision = 0;
      world.system.load.mockResolvedValueOnce(false);
      const saver = createIslandSaver({ system: world.system, adapter: world.adapter, writable: true, idleMs: 1_000 });
      expect(await saver.load()).toBe(true);
      expect(saver.getState().phase).toBe('ready');
      world.edit();
      saver.changed();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(world.system.save).toHaveBeenCalledTimes(1);
    });

    it('뒤에 시작한 불러오기가 이미 끝났다면 밀려난 불러오기가 늦게 끝나도 상태를 바꾸지 않는다', async () => {
      const world = fakeWorld();
      world.adapter.revision = 2;
      let overtaken!: (applied: boolean) => void;
      world.system.load.mockImplementationOnce(() => new Promise<boolean>((done) => (overtaken = done)));
      const saver = createIslandSaver({ system: world.system, adapter: world.adapter, writable: true });
      const first = saver.load();
      expect(await saver.load()).toBe(true);
      expect(saver.getState().phase).toBe('ready');
      overtaken(false);
      expect(await first).toBe(false);
      expect(saver.getState()).toMatchObject({ phase: 'ready', problem: null });
    });

    it('밀려난 불러오기가 던져도 새 불러오기의 상태를 건드리지 않는다', async () => {
      const world = fakeWorld();
      let overtaken!: (error: unknown) => void;
      world.system.load.mockImplementationOnce(() => new Promise<boolean>((_done, fail) => (overtaken = fail)));
      const saver = createIslandSaver({ system: world.system, adapter: world.adapter, writable: true });
      const first = saver.load();
      await saver.load();
      overtaken(new TypeError('Failed to fetch'));
      expect(await first).toBe(false);
      expect(saver.getState().phase).toBe('ready');
    });
  });

  it('방문자의 저장기는 아무것도 쓰지 않는다', async () => {
    const world = fakeWorld();
    const saver = await ready(world, { writable: false });
    world.edit();
    saver.changed();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await saver.save()).toBe(false);
    expect(world.system.save).not.toHaveBeenCalled();
  });

  it('섬을 불러오지 못하면 저장하지 않고 다시 불러올 수 있다', async () => {
    const world = fakeWorld();
    world.system.load.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const saver = createIslandSaver({ system: world.system, adapter: world.adapter, writable: true });
    expect(await saver.load()).toBe(false);
    expect(saver.getState().phase).toBe('loadFailed');
    expect(await saver.save()).toBe(false);
    expect(await saver.load()).toBe(true);
    expect(saver.getState().phase).toBe('ready');
  });
});

describe('save messages', () => {
  it('실패마다 주인이 알아들을 말을 고른다', () => {
    expect(describeSaveError(new ApiRequestError(409, 'revision_conflict', ''))).toBe('conflict');
    const large = describeSaveError(new ApiRequestError(413, 'world_too_large', ''), 2.5 * 1024 * 1024);
    expect(large).toMatchObject({ kind: 'tooLarge' });
    expect(large !== 'conflict' && large.message).toContain('2MB');
    expect(describeSaveError(new ApiRequestError(422, 'invalid_world', ''))).toMatchObject({ kind: 'invalid' });
    expect(describeSaveError(new ApiRequestError(400, 'http_error', ''))).toMatchObject({ kind: 'invalid' });
    expect(describeSaveError(new ApiRequestError(404, 'not_found', ''))).toMatchObject({ kind: 'invalid' });
    expect(describeSaveError(new ApiRequestError(401, 'login_required', ''))).toMatchObject({ kind: 'session' });
    expect(describeSaveError(new ApiRequestError(403, 'forbidden', ''))).toMatchObject({ kind: 'auth' });
    expect(describeSaveError(new ApiRequestError(409, 'owner_changed', ''))).toMatchObject({ kind: 'auth' });
    expect(describeSaveError(new ApiRequestError(408, 'http_error', ''))).toMatchObject({ kind: 'server' });
    expect(describeSaveError(new ApiRequestError(429, 'rate_limited', ''))).toMatchObject({ kind: 'server' });
    expect(describeSaveError(new ApiRequestError(503, 'database', ''))).toMatchObject({ kind: 'server' });
    expect(describeSaveError(new TypeError('Failed to fetch'))).toMatchObject({ kind: 'network' });
  });

  it('다시 보내서 될 실패, 로그인 뒤에 저장될 실패, 섬을 바꿔야 할 실패를 가른다', () => {
    const problem = (kind: SaveProblem['kind']): SaveProblem => ({ kind, message: '' });
    expect(retryable(problem('network'))).toBe(true);
    expect(retryable(problem('server'))).toBe(true);
    expect(retryable(problem('session'))).toBe(false);
    expect(savesLater(problem('session'))).toBe(true);
    for (const kind of ['tooLarge', 'invalid', 'auth'] as const) {
      expect(retryable(problem(kind))).toBe(false);
      expect(savesLater(problem(kind))).toBe(false);
    }
  });

  it('상태 한 줄: 저장됨 · 저장 중 · 저장 안 된 변경 · 저장 못 함', () => {
    const base = { phase: 'ready', saving: false, dirty: false, conflict: false, problem: null, lastSavedAt: null, bytes: null } as const;
    expect(describeStatus(base).label).toBe('저장됨');
    expect(describeStatus({ ...base, saving: true }).label).toBe('저장 중…');
    expect(describeStatus({ ...base, dirty: true }).label).toBe('저장 안 된 변경');
    expect(describeStatus({ ...base, dirty: true, problem: { kind: 'network', message: 'x' } }).label).toBe('저장 못 함');
    expect(describeStatus({ ...base, conflict: true }).tone).toBe('bad');
    expect(describeStatus({ ...base, phase: 'loading' }).label).toBe('불러오는 중');
  });
});
