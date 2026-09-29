import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { currentStudioSleep, reportStudio } from '../../api/studioSleep';
import { ApiError, isDefinitiveRejection, request } from '../api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const WAKING = { code: 'studio_waking', message: '스튜디오를 켜는 중이에요. 1~2분 걸려요.' };

describe('잠든 스튜디오', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    reportStudio();
  });

  it('studio_waking 답을 기억했다가 스튜디오가 답하면 지운다', async () => {
    fetchMock.mockResolvedValueOnce(json(503, WAKING)).mockResolvedValueOnce(json(503, WAKING));
    const first = await request('/api/avatar-factory/wardrobe/bodies').catch((error: unknown) => error);
    expect(first).toBeInstanceOf(ApiError);
    expect(first).toMatchObject({ status: 503, code: 'studio_waking', message: WAKING.message });
    const since = currentStudioSleep()?.since;
    expect(currentStudioSleep()).toMatchObject({ code: 'studio_waking', message: WAKING.message });
    await request('/api/studio/catalog').catch(() => undefined);
    expect(currentStudioSleep()?.since).toBe(since);

    fetchMock.mockResolvedValueOnce(json(200, { bodies: [] }));
    await expect(request('/api/avatar-factory/wardrobe/bodies')).resolves.toEqual({ bodies: [] });
    expect(currentStudioSleep()).toBeNull();
  });

  it('잠든 동안 거절된 유료 요청은 같은 키로 다시 보내도록 남긴다', async () => {
    fetchMock.mockResolvedValueOnce(json(503, { code: 'studio_stopping', message: '꺼지는 중' }));
    const error = await request('/api/studio/generations', { method: 'POST' }).catch((problem: unknown) => problem);
    expect(error).toMatchObject({ code: 'studio_stopping' });
    expect(isDefinitiveRejection(error)).toBe(false);
  });

  it('서버의 다른 거절은 그 메시지를 보이고 판단은 전과 같다', async () => {
    fetchMock.mockResolvedValueOnce(json(502, { code: 'factory_unavailable', message: '캐릭터 서버에 연결하지 못했습니다.' }));
    const error = await request('/api/studio/catalog').catch((problem: unknown) => problem);
    expect(error).toMatchObject({ status: 502, code: 'request_failed', message: '캐릭터 서버에 연결하지 못했습니다.' });
    expect(isDefinitiveRejection(error)).toBe(false);
    expect(currentStudioSleep()).toBeNull();
  });
});
