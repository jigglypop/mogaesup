import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reportStudio } from '../../api/studioSleep';
import { request } from '../api';

const answer = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const messageOf = (promise: Promise<unknown>) => promise.then(() => '', (error: Error) => error.message);

describe('스튜디오 요청이 실패했을 때 화면에 닿는 문장', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    reportStudio();
  });

  it.each([
    [401, '로그인이 필요합니다. 다시 로그인해 주세요.'],
    [404, '요청한 자료를 찾을 수 없습니다.'],
    [422, '요청을 처리하지 못했습니다. 입력을 확인해 주세요.'],
    [500, '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'],
    [503, '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'],
  ])('서버가 이유를 주지 않은 %i은 개발용 안내 대신 무슨 일인지만 알린다', async (status, message) => {
    fetchMock.mockResolvedValueOnce(answer(status, {}));
    const text = await messageOf(request('/api/avatar-factory/wardrobe/bodies'));
    expect(text).toBe(message);
    expect(text).not.toMatch(/API|백엔드|프론트|로컬|주소/);
  });

  it('서버가 준 이유는 그대로 보인다', async () => {
    fetchMock.mockResolvedValueOnce(answer(404, { error: { code: 'preview_missing', message: '이 파츠에는 정면 그림이 없습니다.' } }));
    expect(await messageOf(request('/api/avatar-factory/wardrobe/previews/j/top'))).toBe('이 파츠에는 정면 그림이 없습니다.');
  });

  it('연결하지 못하면 다시 시도해 달라고만 알린다', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await messageOf(request('/api/avatar-factory/wardrobe/bodies'))).toBe('서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  });
});
