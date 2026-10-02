import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHomeSaveAdapter, isSaveConflict, IslandTooLargeError, MAX_ISLAND_BYTES } from '../persistence';
import { setSessionOwner } from '../../auth/sessionWork';

const blob = { version: 1, savedAt: 1, domains: { building: { objects: [] } } };
const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('home save adapter', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    setSessionOwner('owner');
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    setSessionOwner(null);
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('저장한 적 없는 섬은 null로 읽고 리비전 0에서 처음 저장한다', async () => {
    const adapter = createHomeSaveAdapter({ username: 'mogae', ownerId: 'owner', worldId: 'minihome-v6', writable: true });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(adapter.read('main')).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(json(200, { worldId: 'minihome-v6', revision: 1, data: blob, updatedAt: '' }));
    await adapter.write('main', blob);
    const request = fetchMock.mock.calls[1]!;
    expect(String(request[0])).toBe('/api/homes/me/world');
    expect(JSON.parse(String(request[1]?.body))).toEqual({ expectedOwnerId: 'owner', worldId: 'minihome-v6', baseRevision: 0, data: blob });
    await expect(adapter.list()).resolves.toEqual(['main']);
  });

  it('읽은 리비전을 기준으로 저장하고, 충돌은 409로 알린다', async () => {
    const adapter = createHomeSaveAdapter({ username: 'mogae', ownerId: 'owner', worldId: 'minihome-v6', writable: true });
    fetchMock.mockResolvedValueOnce(json(200, { worldId: 'minihome-v6', revision: 7, data: blob, updatedAt: '' }));
    await expect(adapter.read('main')).resolves.toEqual(blob);
    fetchMock.mockResolvedValueOnce(json(409, { code: 'revision_conflict', message: '다른 곳에서 먼저 저장했습니다.' }));
    const error = await adapter.write('main', blob).catch((problem: unknown) => problem);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).baseRevision).toBe(7);
    expect(isSaveConflict(error)).toBe(true);
  });

  it('2MB가 넘는 섬은 보내지 않고, 보낸 크기를 기억한다', async () => {
    const adapter = createHomeSaveAdapter({ username: 'mogae', ownerId: 'owner', worldId: 'minihome-v6', writable: true });
    const huge = { ...blob, domains: { building: { objects: [], note: 'x'.repeat(MAX_ISLAND_BYTES) } } };
    const error = await adapter.write('main', huge).catch((problem: unknown) => problem);
    expect(error).toBeInstanceOf(IslandTooLargeError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(adapter.lastBytes).toBeGreaterThan(MAX_ISLAND_BYTES);
    fetchMock.mockResolvedValueOnce(json(200, { worldId: 'minihome-v6', revision: 1, data: blob, updatedAt: '' }));
    await adapter.write('main', blob);
    expect(adapter.lastBytes).toBe(JSON.stringify(blob).length);
  });

  it('충돌 뒤 최신 리비전만 읽어 와 그 위에 저장한다', async () => {
    const adapter = createHomeSaveAdapter({ username: 'mogae', ownerId: 'owner', worldId: 'minihome-v6', writable: true });
    fetchMock.mockResolvedValueOnce(json(200, { worldId: 'minihome-v6', revision: 7, data: blob, updatedAt: '' }));
    await adapter.read('main');
    fetchMock.mockResolvedValueOnce(json(200, { worldId: 'minihome-v6', revision: 9, data: blob, updatedAt: '' }));
    await adapter.refreshRevision();
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('/api/homes/mogae/world?worldId=minihome-v6');
    fetchMock.mockResolvedValueOnce(json(200, { worldId: 'minihome-v6', revision: 10, data: blob, updatedAt: '' }));
    await adapter.write('main', blob);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).baseRevision).toBe(9);
  });

  it('저장된 섬의 리비전을 알려 준다: 없으면 0, 읽으면 그 값, 저장하면 새 값', async () => {
    const adapter = createHomeSaveAdapter({ username: 'mogae', ownerId: 'owner', worldId: 'minihome-v6', writable: true });
    expect(adapter.revision).toBe(0);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await adapter.read('main');
    expect(adapter.revision).toBe(0);
    fetchMock.mockResolvedValueOnce(json(200, { worldId: 'minihome-v6', revision: 7, data: blob, updatedAt: '' }));
    await adapter.read('main');
    expect(adapter.revision).toBe(7);
    fetchMock.mockResolvedValueOnce(json(200, { worldId: 'minihome-v6', revision: 8, data: blob, updatedAt: '' }));
    await adapter.write('main', blob);
    expect(adapter.revision).toBe(8);
  });

  it('방문자의 저장소는 절대 쓰지 않는다', async () => {
    const adapter = createHomeSaveAdapter({ username: 'mogae', ownerId: 'owner', worldId: 'minihome-v6', writable: false });
    await adapter.write('main', blob);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('계정이 바뀌면 진행 중 요청을 취소하고 새 쿠키로 옛 섬을 다시 저장하지 않는다', async () => {
    const adapter = createHomeSaveAdapter({ username: 'mogae', ownerId: 'owner', worldId: 'minihome-v6', writable: true });
    fetchMock.mockImplementationOnce((_path, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = adapter.write('main', blob).catch((problem: unknown) => problem);
    setSessionOwner('other-owner');
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(await pending).toMatchObject({ name: 'AbortError' });
    const rejected = await adapter.write('main', blob).catch((problem: unknown) => problem);
    expect(rejected).toMatchObject({ status: 409, code: 'owner_changed' });
    expect(isSaveConflict(rejected)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
