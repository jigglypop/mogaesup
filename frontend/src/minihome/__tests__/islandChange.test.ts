import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SaveBlob } from 'gaesup-world';
import type { BuildingSerializedState } from 'gaesup-world/building';

import { expireSession, setSessionOwner } from '../../auth/sessionWork';
import { BEFORE_WORLD_ID, changeIsland, createIslandBackup, IslandChangeError, restoreIsland, type IslandChangeContext, type KeptIsland } from '../edit/islandChange';
import { templateOf } from '../islands';
import { createIslandStore } from '../islands/domain';
import { createResidentStore, type Resident } from '../residents';
import { MINIHOME_WORLD_ID } from '../world';

const resident = (id: string, x: number): Resident => ({ id, npc: 'npc-a', name: `주민 ${id}`, greeting: '안녕', position: [x, 0, x], rotation: 1 });
const blobOf = (template: string, note: string): SaveBlob => ({ version: 1, savedAt: 1, domains: { building: { note }, island: { version: 1, template } } });

/**
 * An island in a world whose save is a blob of its building and kind, a server holding its stored island and the kept
 * one from before, and a log of what happened in which order.
 */
function world({ stored = blobOf('forest', 'stored') as SaveBlob | null, kept = null as KeptIsland | null } = {}) {
  const log: string[] = [];
  const server = { main: stored, before: kept };
  const island = createIslandStore();
  const residents = createResidentStore([resident('a', 9), resident('b', -9)]);
  let current: SaveBlob = blobOf('forest', 'local');
  const runtime = {
    buildingStore: {
      getState: () => ({
        hydrate: (state: BuildingSerializedState) => {
          log.push('hydrate');
          current = { ...current, domains: { ...current.domains, building: state } };
        },
      }),
    },
    save: {
      createBlob: () => structuredClone({ ...current, domains: { ...current.domains, island: { version: 1, template: island.getState() } } }),
      hydrateBlob: (blob: SaveBlob) => {
        if ((blob.domains['building'] as { broken?: boolean }).broken) throw new Error('bad island');
        log.push(`load ${(blob.domains['building'] as { note: string }).note}`);
        current = structuredClone(blob);
        island.set((blob.domains['island'] as { template: 'forest' | 'city' }).template);
        return true;
      },
    },
  };
  const ctx: IslandChangeContext = {
    saver: {
      flush: vi.fn(async () => (log.push('flush'), true)),
      save: vi.fn(async () => {
        log.push('save');
        server.main = runtime.save.createBlob();
        return true;
      }),
    },
    backup: {
      read: vi.fn(async () => (log.push('read kept'), server.before)),
      keep: vi.fn(async () => {
        log.push('keep');
        if (!server.main) return false;
        server.before = { blob: server.main, updatedAt: '2026-10-07T10:00:00Z' };
        return true;
      }),
    },
    runtime,
    island,
    residents,
    history: { stop: vi.fn(() => log.push('history stop')), start: vi.fn(() => log.push('history start')) },
    arrive: vi.fn(() => log.push('arrive')),
  };
  return { ctx, log, server, island, residents, current: () => current };
}

describe('섬 바꾸기', () => {
  it('저장 안 된 편집을 먼저 저장하고, 지금 섬을 보관한 뒤 바꿔서 저장한다', async () => {
    const { ctx, log, server, island, residents } = world();
    await expect(changeIsland(ctx, 'city')).resolves.toBe(true);
    expect(log).toEqual(['flush', 'keep', 'history stop', 'hydrate', 'history start', 'arrive', 'save']);
    expect(island.getState()).toBe('city');
    expect(server.before?.blob.domains['building']).toEqual({ note: 'stored' });
    // Residents keep who they are and stand on the new island's spots.
    const city = templateOf('city');
    expect(residents.getState().map(({ id, name, position }) => [id, name, position[0], position[2]])).toEqual([
      ['a', '주민 a', ...city.residentSpots[0]!],
      ['b', '주민 b', ...city.residentSpots[1]!],
    ]);
  });

  it('지금 섬을 저장하지 못하면 아무것도 바꾸지 않는다', async () => {
    const { ctx, log, island } = world();
    vi.mocked(ctx.saver.flush).mockResolvedValueOnce(false);
    await expect(changeIsland(ctx, 'cafe')).rejects.toBeInstanceOf(IslandChangeError);
    expect(log).toEqual([]);
    expect(island.getState()).toBe('forest');
  });

  it('보관하지 못하면 바꾸지 않는다', async () => {
    const { ctx, log, island } = world();
    vi.mocked(ctx.backup.keep).mockRejectedValueOnce(new TypeError('offline'));
    await expect(changeIsland(ctx, 'cafe')).rejects.toThrow('이전 섬을 보관하지 못해');
    expect(log).toEqual(['flush']);
    expect(island.getState()).toBe('forest');
  });

  it('저장된 섬이 없으면 보관할 것 없이 바로 바꾼다', async () => {
    const { ctx, server, island } = world({ stored: null });
    await changeIsland(ctx, 'park');
    expect(server.before).toBeNull();
    expect(island.getState()).toBe('park');
    expect(server.main?.domains['island']).toEqual({ version: 1, template: 'park' });
  });
});

describe('이전 섬', () => {
  it('보관한 섬과 지금 섬이 서로 자리를 바꾼다', async () => {
    const kept = { blob: blobOf('city', 'kept city'), updatedAt: '2026-10-07T09:00:00Z' };
    const { ctx, log, server, island } = world({ stored: blobOf('cafe', 'stored cafe'), kept });
    await expect(restoreIsland(ctx)).resolves.toBe(true);
    expect(log).toEqual(['flush', 'read kept', 'history stop', 'load kept city', 'history start', 'keep', 'arrive', 'save']);
    expect(island.getState()).toBe('city');
    expect(server.before?.blob.domains['building']).toEqual({ note: 'stored cafe' });
    expect(server.main?.domains['island']).toEqual({ version: 1, template: 'city' });
  });

  it('보관한 섬이 없으면 아무것도 바꾸지 않는다', async () => {
    const { ctx, island, log } = world();
    await expect(restoreIsland(ctx)).rejects.toThrow('이전 섬이 없어요');
    expect(island.getState()).toBe('forest');
    expect(log).toEqual(['flush', 'read kept']);
  });

  it('읽을 수 없는 보관본은 지금 섬을 건드리지 않는다', async () => {
    const broken = { blob: { version: 1, savedAt: 1, domains: { building: { broken: true } } }, updatedAt: '' };
    const { ctx, server } = world({ kept: broken });
    await expect(restoreIsland(ctx)).rejects.toThrow('이전 섬을 불러오지 못했어요');
    expect(ctx.backup.keep).not.toHaveBeenCalled();
    expect(server.before).toBe(broken);
  });

  it('지금 섬을 보관하지 못하면 지금 섬으로 돌아간다', async () => {
    const kept = { blob: blobOf('city', 'kept city'), updatedAt: '' };
    const { ctx, island, current } = world({ kept });
    vi.mocked(ctx.backup.keep).mockRejectedValueOnce(new TypeError('offline'));
    await expect(restoreIsland(ctx)).rejects.toThrow('이전 섬을 보관하지 못해');
    expect(island.getState()).toBe('forest');
    expect(current().domains['building']).toEqual({ note: 'local' });
    expect(ctx.saver.save).not.toHaveBeenCalled();
  });
});

describe('이전 섬 보관', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  beforeEach(() => {
    setSessionOwner('owner');
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    setSessionOwner(null);
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('저장된 섬을 같은 저장 경로로 이전 섬 자리에 옮겨 둔다', async () => {
    const backup = createIslandBackup({ username: 'mogae', ownerId: 'owner' });
    const stored = blobOf('city', 'stored');
    fetchMock
      .mockResolvedValueOnce(json(200, { worldId: MINIHOME_WORLD_ID, revision: 4, data: stored, updatedAt: '' }))
      .mockResolvedValueOnce(json(200, { worldId: BEFORE_WORLD_ID, revision: 2, data: blobOf('forest', 'old'), updatedAt: '' }))
      .mockResolvedValueOnce(json(200, { worldId: BEFORE_WORLD_ID, revision: 3, updatedAt: '' }));
    await expect(backup.keep()).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`/api/homes/mogae/world?worldId=${MINIHOME_WORLD_ID}`);
    expect(String(fetchMock.mock.calls[1]![0])).toBe(`/api/homes/mogae/world?worldId=${BEFORE_WORLD_ID}`);
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toEqual({ expectedOwnerId: 'owner', worldId: BEFORE_WORLD_ID, baseRevision: 2, data: stored });
    backup.dispose();
  });

  it('저장된 섬이 없으면 아무것도 쓰지 않는다', async () => {
    const backup = createIslandBackup({ username: 'mogae', ownerId: 'owner' });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(backup.keep()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    backup.dispose();
  });

  it('보관본을 그 저장 시각과 함께 읽는다', async () => {
    const backup = createIslandBackup({ username: 'mogae', ownerId: 'owner' });
    fetchMock.mockResolvedValueOnce(json(200, { worldId: BEFORE_WORLD_ID, revision: 2, data: blobOf('farm', 'old'), updatedAt: '2026-10-07T09:00:00Z' }));
    await expect(backup.read()).resolves.toEqual({ blob: blobOf('farm', 'old'), updatedAt: '2026-10-07T09:00:00Z' });
    backup.dispose();
  });

  it('로그인이 풀린 채로는 보관하지 않는다', async () => {
    const backup = createIslandBackup({ username: 'mogae', ownerId: 'owner' });
    expireSession();
    fetchMock.mockResolvedValueOnce(json(200, { worldId: MINIHOME_WORLD_ID, revision: 4, data: blobOf('city', 'stored'), updatedAt: '' }));
    fetchMock.mockResolvedValueOnce(json(200, { worldId: BEFORE_WORLD_ID, revision: 2, data: blobOf('forest', 'old'), updatedAt: '' }));
    await expect(backup.keep()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
    backup.dispose();
  });
});
