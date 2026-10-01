import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api';
import { factoryApi } from '../factory/api';

const CHARACTER = 'char-1';
const STORAGE = `gaesup.image-production:${CHARACTER}`;
const input = (changes: Record<string, unknown> = {}) => ({
  character_id: CHARACTER,
  source_sha256: 'a'.repeat(64),
  blueprint_revision: 'rev-1',
  image_mode: 'generate' as const,
  slots: ['body', 'hair'],
  view_mode: 'front_side_back' as const,
  hair_length: 'source' as const,
  ...changes,
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const stored = () => JSON.parse(localStorage.getItem(STORAGE) ?? 'null') as { key: string; input: ReturnType<typeof input> } | null;

describe('이미지 생성 요청 기록', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('기록이 없으면 비어 있다', () => {
    expect(factoryApi.imageRecovery(CHARACTER)).toEqual({ pending: null, error: '' });
  });

  it('깨진 기록은 던지지 않고 읽을 수 없다고 알린다', () => {
    for (const raw of ['{not json', 'null', '"text"', '[]', JSON.stringify({ key: 'k' }), JSON.stringify({ key: 'k', input: 5 })]) {
      localStorage.setItem(STORAGE, raw);
      const { pending, error } = factoryApi.imageRecovery(CHARACTER);
      expect(pending).toBeNull();
      expect(error).toContain('읽을 수 없습니다');
    }
  });

  it('모양이 맞지 않는 입력도 읽을 수 없다고 알린다', () => {
    for (const bad of [{ slots: 'body' }, { slots: [] }, { slots: [1] }, { image_mode: 'x' }, { character_id: 'other' }, { view_mode: 'x' }, { meshy_options: 'x' }]) {
      localStorage.setItem(STORAGE, JSON.stringify({ key: 'k', input: input(bad) }));
      expect(factoryApi.imageRecovery(CHARACTER).error).toContain('읽을 수 없습니다');
    }
    localStorage.setItem(STORAGE, JSON.stringify({ key: 'k', input: input() }));
    expect(factoryApi.imageRecovery(CHARACTER)).toEqual({ pending: { key: 'k', input: input() }, error: '' });
  });

  it('읽을 수 없는 기록이 있으면 새 요청을 보내지 않는다', async () => {
    localStorage.setItem(STORAGE, '{not json');
    await expect(factoryApi.produceImage(input())).rejects.toThrow('읽을 수 없습니다');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('옛 버전이 탭에만 둔 기록은 옮겨 읽고 탭의 것은 지운다', () => {
    sessionStorage.setItem(STORAGE, JSON.stringify({ key: 'old', input: input() }));
    expect(factoryApi.imageRecovery(CHARACTER).pending?.key).toBe('old');
    expect(stored()?.key).toBe('old');
    expect(sessionStorage.getItem(STORAGE)).toBeNull();
  });

  it('보내기 전에 키와 함께 저장하고, 답을 받으면 지운다', async () => {
    fetchMock.mockImplementationOnce(async (_url, init) => {
      expect(stored()?.key).toBe(new Headers(init?.headers).get('Idempotency-Key'));
      return json(200, { id: 'job-1' });
    });
    await expect(factoryApi.produceImage(input())).resolves.toEqual({ id: 'job-1' });
    expect(stored()).toBeNull();
  });

  it('답을 잃으면 기록을 남기고, 같은 요청으로만 같은 키로 다시 보낸다', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(factoryApi.produceImage(input())).rejects.toBeInstanceOf(ApiError);
    const saved = stored()!;
    expect(saved.input).toEqual(input());

    fetchMock.mockResolvedValueOnce(json(200, { id: 'job-1' }));
    await factoryApi.produceImage(saved.input, saved.key);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Idempotency-Key')).toBe(saved.key);
    expect(stored()).toBeNull();
  });

  it('저장된 요청이 있을 때 다른 입력은 저장된 것으로 바꿔 보내지 않고 거절한다', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await factoryApi.produceImage(input()).catch(() => undefined);
    const saved = stored()!;
    fetchMock.mockClear();

    await expect(factoryApi.produceImage(input({ slots: ['hat'] }))).rejects.toThrow('저장된 이미지 생성 요청이 있습니다');
    // 복구 키 없이 같은 입력을 보내는 것도 복구가 아니므로 거절한다.
    await expect(factoryApi.produceImage(input())).rejects.toThrow('저장된 이미지 생성 요청이 있습니다');
    await expect(factoryApi.produceImage(input({ slots: ['hat'] }), 'other-key')).rejects.toThrow('저장된 이미지 생성 요청이 있습니다');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stored()).toEqual(saved);
  });

  it('서버가 확실히 거절하면 기록을 지워 다음 요청을 막지 않는다', async () => {
    fetchMock.mockResolvedValueOnce(json(429, { code: 'factory_budget', message: '이번 달 유료 캐릭터 작업 한도를 다 썼습니다.' }));
    await expect(factoryApi.produceImage(input())).rejects.toMatchObject({ code: 'factory_budget', status: 429 });
    expect(stored()).toBeNull();
    expect(factoryApi.imageRecovery(CHARACTER)).toEqual({ pending: null, error: '' });
  });
});
