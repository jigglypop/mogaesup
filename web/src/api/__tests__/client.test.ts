import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiRequestError } from '../client';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
});
