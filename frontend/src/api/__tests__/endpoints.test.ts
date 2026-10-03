import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { homeApi, homesPath, layoutApi } from '../endpoints';

describe('섬 목록 주소', () => {
  it('정한 것만 붙인다', () => {
    expect(homesPath()).toBe('/homes');
    expect(homesPath({})).toBe('/homes');
    expect(homesPath({ limit: 24 })).toBe('/homes?limit=24');
    expect(homesPath({ q: '' })).toBe('/homes');
  });

  it('검색어와 이어 볼 시각을 주소 안전하게 보낸다', () => {
    const path = homesPath({ limit: 24, before: '2026-09-30T12:34:56.123456+09:00', q: '모개 숲&' });
    const query = new URLSearchParams(path.slice('/homes?'.length));
    expect(query.get('limit')).toBe('24');
    expect(query.get('before')).toBe('2026-09-30T12:34:56.123456+09:00');
    expect(query.get('q')).toBe('모개 숲&');
    // 시간대의 +가 공백으로 읽히면 안 된다.
    expect(path).toContain('%2B09%3A00');
    expect(path).not.toContain('모');
  });

  describe('목록을 부를 때', () => {
    const fetchMock = vi.fn<typeof fetch>();
    beforeEach(() => vi.stubGlobal('fetch', fetchMock));
    afterEach(() => {
      fetchMock.mockReset();
      vi.unstubAllGlobals();
    });

    it('쪽과 검색어를 주소에 싣는다', async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ homes: [] }), { status: 200 }));
      await homeApi.list({ limit: 24, q: '모개' });
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`/api${homesPath({ limit: 24, q: '모개' })}`);
    });

    it('AI 배치의 재시도는 같은 요청키를 전달한다', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ kind: 'cafe' }), { status: 200 }));
      const body = { description: '12m 카페', mode: 'ai' as const, requestId: 'layout-request-123' };
      await layoutApi.interpret(body);
      await layoutApi.interpret(body);
      for (const [url, options] of fetchMock.mock.calls) {
        expect(url).toBe('/api/studio/layouts/interpret');
        expect(options?.headers).toMatchObject({ 'Idempotency-Key': body.requestId, 'content-type': 'application/json' });
        expect(JSON.parse(options?.body as string)).toEqual(body);
      }
    });

    it('섬 저장은 다른 요청보다 오래, 60초를 기다린다', async () => {
      vi.useFakeTimers();
      try {
        fetchMock.mockImplementationOnce(
          (_url, init) =>
            new Promise<Response>((_resolve, reject) =>
              init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))),
            ),
        );
        const result = homeApi.saveWorld({ expectedOwnerId: 'owner', worldId: 'w', baseRevision: 1, data: {} }).catch((problem: unknown) => problem);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toMatchObject({ name: 'ApiTimeoutError', ms: 60_000 });
      } finally {
        vi.useRealTimers();
      }
    });

    it('검색어가 바뀌어 부른 쪽이 끊으면 가던 요청도 끊긴다', async () => {
      fetchMock.mockImplementationOnce(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))),
          ),
      );
      const controller = new AbortController();
      const result = homeApi.list({ q: '모' }, controller.signal);
      controller.abort();
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});
