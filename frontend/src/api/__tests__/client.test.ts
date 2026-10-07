import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { followSessionOwner, onSessionLapse, onSessionRenewed, sessionLapsed, setSessionOwner } from '../../auth/sessionWork';
import { api, ApiRequestError, ApiTimeoutError, DEFAULT_TIMEOUT_MS, problemText } from '../client';

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

  it('캐릭터 서버가 그대로 넘긴 {error:{code,message}} 오류도 코드와 메시지로 옮긴다', async () => {
    fetchMock
      .mockResolvedValueOnce(json(503, { error: { code: 'layout_ai_unavailable', message: 'AI 해석 설정을 확인해 주세요.' } }))
      .mockResolvedValueOnce(json(504, { error: { code: 'layout_interpretation_uncertain' } }));
    await expect(api('/studio/layouts/interpret', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 503,
      code: 'layout_ai_unavailable',
      message: 'AI 해석 설정을 확인해 주세요.',
    });
    await expect(api('/studio/layouts/interpret', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 504,
      code: 'layout_interpretation_uncertain',
      message: '요청이 실패했어요 (504)',
    });
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

    it('세션을 거절한 것이 아닌 401은 세션을 풀지 않는다', async () => {
      // A character-server or realtime refusal passed on as-is must not sign the member out of the app.
      fetchMock
        .mockResolvedValueOnce(json(401, { code: 'ticket', message: '' }))
        .mockResolvedValueOnce(json(401, { code: 'wrong_password', message: '' }))
        .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
        .mockResolvedValueOnce(json(502, { code: 'factory_auth', message: '' }))
        .mockResolvedValueOnce(json(401, { error: { code: 'login_required', message: '' } }));
      await expect(api('/rooms/ticket', { method: 'POST' })).rejects.toMatchObject({ status: 401, code: 'ticket' });
      await expect(api('/auth/password', { method: 'POST' })).rejects.toMatchObject({ status: 401, code: 'wrong_password' });
      await expect(api('/factory/characters')).rejects.toMatchObject({ status: 401, code: 'http_error' });
      await expect(api('/factory/characters')).rejects.toMatchObject({ status: 502, code: 'factory_auth' });
      // Only the app server's own refusal speaks for the session cookie, not one the character server sent on.
      await expect(api('/studio/layouts/capabilities')).rejects.toMatchObject({ status: 401, code: 'login_required' });
      expect(lapses).not.toHaveBeenCalled();
      expect(sessionLapsed()).toBe(false);
    });

    it('세션이 정말 끝난 401은 옛 쿠키 표시 없이 온다', async () => {
      fetchMock.mockResolvedValueOnce(json(401, { code: 'login_required', message: '로그인이 필요합니다.' }));
      const error = await api('/homes/me/world', { method: 'PUT', body: {} }).catch((problem: unknown) => problem);
      expect(error).toMatchObject({ status: 401, staleCookie: false });
      expect(problemText(error)).toBe('로그인이 필요합니다.');
      // Refused for a cookie the page had already replaced: not the member's to sign in again for.
      expect(problemText(new ApiRequestError(401, 'login_required', '로그인이 필요합니다.', true))).toBe('잠시 후 다시 시도해 주세요');
    });

    it.each([
      [507, 'site_storage_full', '지금은 섬을 더 크게 저장할 수 없어요.'],
      [429, 'picture_saving', '앞서 올린 사진을 아직 받고 있어요. 잠시 뒤에 다시 올려 주세요.'],
      [409, 'guestbook_address_full', '오늘은 이 방명록에 더 남길 수 없어요. 내일 다시 남겨 주세요.'],
      [503, 'timeout', '요청을 제때 처리하지 못했어요. 잠시 뒤에 다시 시도해 주세요.'],
      [422, 'invalid_name', '쓸 수 없는 이름입니다.'],
      [413, 'too_large', '요청이 너무 큽니다.'],
      [503, 'wardrobe_busy', '지금 옷장을 여는 사람이 많아요. 잠시 뒤에 다시 시도해 주세요.'],
    ])('서버의 %i %s 거절은 그 말을 그대로 보이고 세션을 풀지 않는다', async (status, code, message) => {
      fetchMock.mockResolvedValueOnce(json(status, { code, message }));
      const error = await api('/homes/me/world', { method: 'PUT', body: {} }).catch((problem: unknown) => problem);
      expect(error).toBeInstanceOf(ApiRequestError);
      expect(error).toMatchObject({ status, code, message });
      expect(problemText(error)).toBe(message);
      expect(lapses).not.toHaveBeenCalled();
      expect(sessionLapsed()).toBe(false);
    });

    describe('세션을 새로 여는 요청(비밀번호 바꾸기, 다른 기기 로그아웃)', () => {
      const refused = () => json(401, { code: 'login_required', message: '로그인이 필요합니다.' });

      it('대답이 오기 전 옛 쿠키가 거절돼도, 그 전에 보낸 요청이 늦게 거절돼도 로그아웃으로 보지 않는다', async () => {
        let answer!: (response: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
        const changing = api('/auth/password', { method: 'POST', body: {}, startsOver: true });
        // 서버가 옛 세션을 지우고 실시간 연결을 닫자 다시 받으려던 티켓이 옛 쿠키로 거절된다.
        fetchMock.mockResolvedValueOnce(refused());
        await expect(api('/auth/realtime-ticket', { method: 'POST' })).rejects.toMatchObject({ status: 401, staleCookie: true });
        let late!: (response: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise((resolve) => (late = resolve)));
        const before = api('/homes/me/world', { method: 'PUT', body: {} }).catch((problem: unknown) => problem);
        answer(new Response(null, { status: 204 }));
        await expect(changing).resolves.toBeUndefined();
        late(refused());
        // The island save sent with the old cookie says so, so it is saved again rather than waiting for a sign-in.
        expect(await before).toMatchObject({ status: 401, staleCookie: true });
        expect(lapses).not.toHaveBeenCalled();
        expect(sessionLapsed()).toBe(false);

        // 새 쿠키로 보낸 요청이 거절되면 그때는 세션이 정말 끝난 것이다.
        fetchMock.mockResolvedValueOnce(refused());
        await expect(api('/auth/realtime-ticket', { method: 'POST' })).rejects.toMatchObject({ status: 401, staleCookie: false });
        expect(lapses).toHaveBeenCalledTimes(1);
      });

      it('새 쿠키를 받으면 다른 탭에 알릴 수 있게 알리고, 옛 쿠키에 막혔던 작업을 잇는다', async () => {
        const renewed = vi.fn();
        const stopRenewed = onSessionRenewed(renewed);
        const resume = vi.fn();
        const unwatch = followSessionOwner('u1', vi.fn(), resume);
        fetchMock.mockResolvedValueOnce(json(200, { ended: 2 }));
        await expect(api('/auth/logout-others', { method: 'POST', startsOver: true })).resolves.toEqual({ ended: 2 });
        expect(renewed).toHaveBeenCalledTimes(1);
        expect(resume).toHaveBeenCalledTimes(1);

        // A wrong password or no answer brings no new cookie: nothing to tell, nothing to carry on.
        fetchMock.mockResolvedValueOnce(json(401, { code: 'wrong_password', message: '' })).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await expect(api('/auth/password', { method: 'POST', body: {}, startsOver: true })).rejects.toMatchObject({ code: 'wrong_password' });
        await expect(api('/auth/password', { method: 'POST', body: {}, startsOver: true })).rejects.toBeInstanceOf(TypeError);
        expect(renewed).toHaveBeenCalledTimes(1);
        expect(resume).toHaveBeenCalledTimes(1);
        unwatch();
        stopRenewed();
      });

      it('그 요청 자체가 끝난 세션으로 거절되면 로그아웃으로 본다', async () => {
        fetchMock.mockResolvedValueOnce(refused());
        await expect(api('/auth/logout-others', { method: 'POST', startsOver: true })).rejects.toMatchObject({ status: 401 });
        expect(lapses).toHaveBeenCalledTimes(1);
        expect(sessionLapsed()).toBe(true);
      });

      it('틀린 비밀번호로 끝나도 그 뒤의 거절은 전처럼 세션을 푼다', async () => {
        fetchMock.mockResolvedValueOnce(json(401, { code: 'wrong_password', message: '' }));
        await expect(api('/auth/password', { method: 'POST', body: {}, startsOver: true })).rejects.toMatchObject({ code: 'wrong_password' });
        expect(lapses).not.toHaveBeenCalled();
        fetchMock.mockResolvedValueOnce(refused());
        await expect(api('/homes/me/world', { method: 'PUT', body: {} })).rejects.toMatchObject({ status: 401 });
        expect(lapses).toHaveBeenCalledTimes(1);
      });
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

    it('시간을 정하지 않으면 서버가 기다리는 시간(25초)과 CDN이 서버를 기다리는 시간(30초)보다 오래 기다린다', async () => {
      // A busy wardrobe or the server's own deadline answers within 25 s, the CDN's 504 at 30 s: both come before this.
      expect(DEFAULT_TIMEOUT_MS).toBe(35_000);
      fetchMock.mockImplementationOnce(hang);
      const result = api('/avatar-factory/wardrobe/bodies').catch((problem: unknown) => problem);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 30_001);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ ms: DEFAULT_TIMEOUT_MS });
      expect(await result).toBeInstanceOf(ApiTimeoutError);
    });

    it('25초 뒤에 온 서버의 거절(옷장 붐빔)도 시간 초과가 아니라 그 말 그대로 받는다', async () => {
      fetchMock.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(json(503, { code: 'wardrobe_busy', message: '지금 옷장을 여는 사람이 많아요. 잠시 뒤에 다시 시도해 주세요.' })), 25_000)),
      );
      const result = api('/avatar-factory/wardrobe/bodies').catch((problem: unknown) => problem);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await result).toMatchObject({ status: 503, code: 'wardrobe_busy', message: '지금 옷장을 여는 사람이 많아요. 잠시 뒤에 다시 시도해 주세요.' });
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
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
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
