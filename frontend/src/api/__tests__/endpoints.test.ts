import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onSessionLapse, setSessionOwner } from '../../auth/sessionWork';
import { authApi, homeApi, homesPath, layoutApi, lookApi, shareUrl, socialApi } from '../endpoints';

describe('섬 공유 링크', () => {
  it('미리보기를 읽는 서버의 공유 페이지를 가리킨다', () => {
    expect(shareUrl('mogae', 'https://mogaesup.com')).toBe('https://mogaesup.com/api/share/@mogae');
    expect(shareUrl('mogae_1')).toBe(`${window.location.origin}/api/share/@mogae_1`);
  });
});

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

  it('다음 쪽은 마지막 섬의 주인 id를 시각과 함께 보낸다', () => {
    const owner = '7d9f2c1e-0b4a-4c3e-9a51-2f6d8e0c4b17';
    const query = new URLSearchParams(homesPath({ limit: 24, before: '2026-09-30T00:00:00Z', beforeId: owner }).slice('/homes?'.length));
    expect(query.get('before')).toBe('2026-09-30T00:00:00Z');
    expect(query.get('beforeId')).toBe(owner);
    // 시각 없는 주인 id는 이어 볼 자리가 아니다.
    expect(homesPath({ beforeId: owner })).toBe('/homes');
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
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ kind: 'cafe' }), { status: 200 }));
      const body = { description: '12m 카페', mode: 'ai' as const, requestId: 'layout-request-123' };
      await layoutApi.interpret(body);
      await layoutApi.interpret(body);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [url, options] of fetchMock.mock.calls) {
        expect(url).toBe('/api/studio/layouts/interpret');
        const headers = new Headers(options?.headers);
        expect([headers.get('idempotency-key'), headers.get('content-type')]).toEqual([body.requestId, 'application/json']);
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

    it('내 캐릭터 저장도 캐릭터 서버를 거쳐 대답하므로 60초를 기다린다', async () => {
      vi.useFakeTimers();
      try {
        fetchMock.mockImplementationOnce(
          (_url, init) =>
            new Promise<Response>((_resolve, reject) =>
              init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))),
            ),
        );
        const result = lookApi.save({ body: { jobId: 'body', version: 'v1' }, parts: {}, hairColor: null, colors: {} }).catch((problem: unknown) => problem);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toMatchObject({ name: 'ApiTimeoutError', ms: 60_000 });
      } finally {
        vi.useRealTimers();
      }
    });

    it('공유 사진은 주인 확인과 함께 JSON으로 올리고 지운다', async () => {
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ profile: {}, visits: {}, isOwner: true }), { status: 200 }));
      await homeApi.setThumbnail({ expectedOwnerId: 'owner', image: 'data:image/jpeg;base64,AAAA' });
      await homeApi.removeThumbnail({ expectedOwnerId: 'owner' });
      const sent = fetchMock.mock.calls.map(([url, init]) => [`${init?.method} ${String(url)}`, JSON.parse(init?.body as string)]);
      expect(sent).toEqual([
        ['PUT /api/homes/me/thumbnail', { expectedOwnerId: 'owner', image: 'data:image/jpeg;base64,AAAA' }],
        ['DELETE /api/homes/me/thumbnail', { expectedOwnerId: 'owner' }],
      ]);
      for (const [, init] of fetchMock.mock.calls) expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
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

  describe('이웃 신청 목록', () => {
    const fetchMock = vi.fn<typeof fetch>();
    const list = () => new Response(JSON.stringify({ received: [], sent: [] }), { status: 200 });
    beforeEach(() => vi.stubGlobal('fetch', fetchMock));
    afterEach(() => {
      fetchMock.mockReset();
      vi.unstubAllGlobals();
    });

    it('종과 이웃 탭이 함께 물으면 한 번만 읽고, 끝난 뒤에는 새로 읽는다', async () => {
      fetchMock.mockImplementation(async () => list());
      const bell = socialApi.requests();
      const tab = socialApi.requests();
      expect(tab).toBe(bell);
      await Promise.all([bell, tab]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await socialApi.requests();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('신청을 수락하면 그 전에 떠난 읽기에 끼지 않고 새로 읽는다', async () => {
      let answer!: (response: Response) => void;
      fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
      fetchMock.mockImplementation(async () => list());
      const before = socialApi.requests();
      await socialApi.accept('r1', {});
      const after = socialApi.requests();
      expect(after).not.toBe(before);
      expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`)).toEqual([
        'GET /api/ilchon-requests',
        'POST /api/ilchon-requests/r1/accept',
        'GET /api/ilchon-requests',
      ]);
      answer(list());
      await Promise.all([before, after]);
    });

    it('다른 사람이 로그인하기 전에 떠난 읽기는 나누지 않는다', async () => {
      fetchMock.mockImplementation(async () => list());
      setSessionOwner('u1');
      const before = socialApi.requests();
      setSessionOwner('u2');
      const after = socialApi.requests();
      expect(after).not.toBe(before);
      await Promise.all([before, after]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      setSessionOwner(null);
    });
  });

  describe('세션을 새로 여는 계정 요청', () => {
    const fetchMock = vi.fn<typeof fetch>();
    const lapses = vi.fn();
    let stop = () => {};
    beforeEach(() => {
      vi.stubGlobal('fetch', fetchMock);
      setSessionOwner('u1');
      stop = onSessionLapse(lapses);
    });
    afterEach(() => {
      stop();
      lapses.mockReset();
      setSessionOwner(null);
      fetchMock.mockReset();
      vi.unstubAllGlobals();
    });

    it.each([
      ['비밀번호 바꾸기', () => authApi.changePassword({ currentPassword: 'old-password', newPassword: 'new-password' }), new Response(null, { status: 204 })],
      ['다른 기기 로그아웃', () => authApi.logoutOthers({ currentPassword: 'old-password' }), new Response(JSON.stringify({ ended: 2 }), { status: 200 })],
    ])('%s 중 닫힌 실시간 연결이 옛 쿠키로 티켓을 거절당해도 로그아웃하지 않는다', async (_name, call, answered) => {
      let answer!: (response: Response) => void;
      fetchMock.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
      const pending = call();
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'login_required', message: '' }), { status: 401 }));
      await expect(authApi.realtimeTicket()).rejects.toMatchObject({ status: 401, code: 'login_required' });
      answer(answered);
      await pending;
      expect(lapses).not.toHaveBeenCalled();
    });
  });
});
