import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onSessionLapse, sessionLapsed, setSessionOwner } from '../../auth/sessionWork';
import { api, ApiRequestError, ApiTimeoutError } from '../client';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** A request that never answers and gives up with an abort, as fetch does when its signal fires. */
const hang = (_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener('abort', abort);
  });

describe('api client', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('세션 쿠키로 보내고, 쓰기는 본문이 없어도 JSON으로 보낸다', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { user: null })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api('/auth/me')).resolves.toEqual({ user: null });
    await expect(api('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
    const [read, write] = fetchMock.mock.calls;
    expect(read?.[1]).toMatchObject({ method: 'GET', credentials: 'same-origin' });
    expect(read?.[1]?.body).toBeUndefined();
    expect(String(write?.[0])).toBe('/api/auth/logout');
    expect(new Headers(write?.[1]?.headers).get('content-type')).toBe('application/json');
    expect(write?.[1]?.body).toBe('{}');
  });

  it('서버 오류 본문을 코드와 메시지로 옮긴다', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { code: 'username_taken', message: '이미 사용 중인 아이디입니다.' }));
    const error = await api('/auth/register', { method: 'POST', body: {} }).catch((problem: unknown) => problem);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 409, code: 'username_taken', message: '이미 사용 중인 아이디입니다.' });
  });

  it('본문이 없는 오류도 상태 코드로 알린다', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad gateway', { status: 502 }));
    await expect(api('/homes')).rejects.toMatchObject({ status: 502, code: 'http_error' });
  });

  describe('세션이 끝났다는 401', () => {
    const lapses = vi.fn();
    let stop = () => {};
    beforeEach(() => {
      setSessionOwner('u1');
      stop = onSessionLapse(lapses);
    });
    afterEach(() => {
      stop();
      lapses.mockReset();
      setSessionOwner(null);
    });

    it('로그인한 사람의 요청이 401을 받으면 세션이 풀린 것으로 알린다', async () => {
      fetchMock.mockResolvedValueOnce(json(401, { code: 'login_required', message: '로그인이 필요합니다.' }));
      await expect(api('/homes/me/world', { method: 'PUT', body: {} })).rejects.toMatchObject({ status: 401 });
      expect(lapses).toHaveBeenCalledTimes(1);
      expect(sessionLapsed()).toBe(true);
    });

    it('틀린 비밀번호의 401은 세션과 상관없다', async () => {
      fetchMock.mockResolvedValueOnce(json(401, { code: 'invalid_credentials', message: '아이디 또는 비밀번호가 올바르지 않습니다.' }));
      await expect(api('/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 401 });
      expect(lapses).not.toHaveBeenCalled();
    });

    it('보낸 뒤에 세션이 바뀌었다면 늦게 온 401은 새 세션을 건드리지 않는다', async () => {
      let answer!: (response: Response) => void;
      fetchMock.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
      const pending = api('/homes/me/world', { method: 'PUT', body: {} }).catch(() => undefined);
      setSessionOwner('u1');
      answer(json(401, { code: 'login_required', message: '' }));
      await pending;
      expect(lapses).not.toHaveBeenCalled();
      expect(sessionLapsed()).toBe(false);
    });
  });

  describe('대답이 없을 때', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('정한 시간 안에 대답이 없으면 ApiTimeoutError로 끝낸다', async () => {
      fetchMock.mockImplementationOnce(hang);
      const result = api('/homes/me/world', { method: 'PUT', body: {}, timeoutMs: 60_000 }).catch((problem: unknown) => problem);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      const error = await result;
      expect(error).toBeInstanceOf(ApiTimeoutError);
      expect(error).toMatchObject({ ms: 60_000 });
      expect(error).not.toBeInstanceOf(ApiRequestError);
    });

    it('시간을 정하지 않으면 30초를 기다린다', async () => {
      fetchMock.mockImplementationOnce(hang);
      const result = api('/homes').catch((problem: unknown) => problem);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBeInstanceOf(ApiTimeoutError);
    });

    it('본문을 읽다가 시간이 다 되어도 같다', async () => {
      let source!: ReadableStreamDefaultController;
      const stalled = new ReadableStream({ start: (controller) => void (source = controller) });
      fetchMock.mockImplementationOnce(async (_url, init) => {
        // A fetch's body stream fails when the request's signal fires.
        init?.signal?.addEventListener('abort', () => source.error(new DOMException('The operation was aborted.', 'AbortError')));
        return new Response(stalled, { status: 200 });
      });
      const result = api('/homes').catch((problem: unknown) => problem);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toBeInstanceOf(ApiTimeoutError);
    });

    it('대답이 오면 타이머를 남기지 않는다', async () => {
      fetchMock.mockResolvedValueOnce(json(200, { homes: [] }));
      await expect(api('/homes')).resolves.toEqual({ homes: [] });
      fetchMock.mockResolvedValueOnce(json(409, { code: 'revision_conflict', message: '충돌' }));
      await expect(api('/homes/me/world', { method: 'PUT' })).rejects.toMatchObject({ status: 409 });
      expect(vi.getTimerCount()).toBe(0);
    });

    it('부른 쪽이 끊은 것은 시간 초과가 아니라 끊김으로 남는다', async () => {
      fetchMock.mockImplementationOnce(hang);
      const controller = new AbortController();
      const result = api('/homes', { signal: controller.signal }).catch((problem: unknown) => problem);
      controller.abort();
      const error = await result;
      expect(error).not.toBeInstanceOf(ApiTimeoutError);
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(vi.getTimerCount()).toBe(0);
    });

    it('이미 끊긴 신호로는 요청이 시작되자마자 끊긴다', async () => {
      fetchMock.mockImplementationOnce(hang);
      const controller = new AbortController();
      controller.abort();
      await expect(api('/homes', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});
