import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHomeSaveAdapter, IslandTooLargeError, MAX_ISLAND_BYTES } from '../persistence';
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
    expect(error).toMatchObject({ status: 409, code: 'revision_conflict' });
    // Nothing was lost on the way, so the conflict is someone else's: the stored island is not even read.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('대답을 잃은 저장 뒤의 충돌', () => {
    const island = (savedAt: number, note = 'a') => ({ version: 1, savedAt, domains: { building: { objects: [], note } } });
    const opened = async () => {
      const adapter = createHomeSaveAdapter({ username: 'mogae', ownerId: 'owner', worldId: 'minihome-v6', writable: true });
      fetchMock.mockResolvedValueOnce(json(200, { worldId: 'minihome-v6', revision: 7, data: island(1), updatedAt: '' }));
      await adapter.read('main');
      return adapter;
    };
    const conflict = () => json(409, { code: 'revision_conflict', message: '다른 곳에서 먼저 저장했어요.' });
    const bodyOf = (call: number) => JSON.parse(String(fetchMock.mock.calls[call]?.[1]?.body));

    it('잃은 저장이 실제로 들어갔다면 충돌로 보지 않고 그 리비전을 이어받는다', async () => {
      const adapter = await opened();
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await expect(adapter.write('main', island(2, 'b'))).rejects.toBeInstanceOf(TypeError);
      // The retry: same island, a new savedAt. The server holds the first one (its keys in its own order).
      fetchMock.mockResolvedValueOnce(conflict());
      fetchMock.mockResolvedValueOnce(json(200, { worldId: 'minihome-v6', revision: 8, data: { domains: { building: { note: 'b', objects: [] } }, savedAt: 2, version: 1 }, updatedAt: '' }));
      await expect(adapter.write('main', island(3, 'b'))).resolves.toBeUndefined();
      expect(adapter.revision).toBe(8);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(String(fetchMock.mock.calls[3]?.[0])).toBe('/api/homes/mogae/world?worldId=minihome-v6');

      fetchMock.mockResolvedValueOnce(json(200, { worldId: 'minihome-v6', revision: 9, data: island(4, 'c'), updatedAt: '' }));
      await adapter.write('main', island(4, 'c'));
      expect(bodyOf(4).baseRevision).toBe(8);
    });

    it('잃은 저장 뒤에 더 꾸몄다면 들어간 저장 위에 지금 섬을 다시 저장한다', async () => {
      const adapter = await opened();
      fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')));
      await adapter.write('main', island(2, 'b')).catch(() => undefined);
      fetchMock.mockResolvedValueOnce(conflict());
      fetchMock.mockResolvedValueOnce(json(200, { worldId: 'minihome-v6', revision: 8, data: island(2, 'b'), updatedAt: '' }));
      fetchMock.mockResolvedValueOnce(json(200, { worldId: 'minihome-v6', revision: 9, data: island(3, 'c'), updatedAt: '' }));
      await expect(adapter.write('main', island(3, 'c'))).resolves.toBeUndefined();
      expect(bodyOf(4)).toMatchObject({ baseRevision: 8, data: island(3, 'c') });
      expect(adapter.revision).toBe(9);
    });

    it('저장된 섬이 보낸 적 없는 섬이면 다른 곳의 저장이라 충돌로 알린다', async () => {
      const adapter = await opened();
      fetchMock.mockResolvedValueOnce(json(504, { code: 'gateway_timeout', message: '' }));
      await adapter.write('main', island(2, 'b')).catch(() => undefined);
      fetchMock.mockResolvedValueOnce(conflict());
      fetchMock.mockResolvedValueOnce(json(200, { worldId: 'minihome-v6', revision: 8, data: island(5, 'other tab'), updatedAt: '' }));
      const error = await adapter.write('main', island(3, 'b')).catch((problem: unknown) => problem);
      expect(error).toMatchObject({ status: 409, code: 'revision_conflict' });
      expect(adapter.revision).toBe(7);
    });
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
