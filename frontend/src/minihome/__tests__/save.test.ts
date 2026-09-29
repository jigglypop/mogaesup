import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../api/client';
import { createIslandSaver, describeSaveError, describeStatus, type IslandSaverOptions } from '../edit/save';
import { IslandTooLargeError } from '../persistence';

/** A save system whose domains move when `edit()` is called and whose writes answer as told. */
function fakeWorld() {
  const revisions = { building: 1, 'gameplay-events': 1 };
  const answers: (Error | null)[] = [];
  const system = {
    save: vi.fn(async () => {
      const answer = answers.shift();
      if (answer) throw answer;
    }),
    load: vi.fn(async () => true),
    getBindings: () =>
      (Object.keys(revisions) as (keyof typeof revisions)[]).map((key) => ({
        key,
        serialize: () => null,
        hydrate: () => {},
        revision: () => revisions[key],
      }))[Symbol.iterator](),
  } as unknown as IslandSaverOptions['system'] & { save: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn> };
  const adapter = { refreshRevision: vi.fn(async () => {}), lastBytes: 1234 };
  return {
    system,
    adapter,
    answers,
    edit(key: keyof typeof revisions = 'building') {
      revisions[key]++;
    },
  };
}

const ready = async (world: ReturnType<typeof fakeWorld>, options: Partial<IslandSaverOptions> = {}) => {
  const saver = createIslandSaver({ system: world.system, adapter: world.adapter, writable: true, ...options });
  await saver.load();
  return saver;
};

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
    expect(describeSaveError(new ApiRequestError(401, 'login_required', ''))).toMatchObject({ kind: 'auth' });
    expect(describeSaveError(new ApiRequestError(503, 'database', ''))).toMatchObject({ kind: 'server' });
    expect(describeSaveError(new TypeError('Failed to fetch'))).toMatchObject({ kind: 'network' });
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
