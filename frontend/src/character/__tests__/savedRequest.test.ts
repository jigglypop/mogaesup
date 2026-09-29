import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, savedRequest, type Pending } from '../api';

type Input = { name: string };
const STORAGE = 'test.saved-request';
const saved = () => savedRequest<Input>(STORAGE, ({ input }) => typeof input.name === 'string', '읽을 수 없음');
const stored = () => JSON.parse(localStorage.getItem(STORAGE) ?? 'null') as Pending<Input> | null;

describe('saved request', () => {
  afterEach(() => localStorage.clear());

  it('보내기 전에 키와 함께 저장하고, 답을 받으면 지운다', async () => {
    const post = vi.fn(async (pending: Pending<Input>) => {
      expect(stored()).toEqual(pending);
      return pending.key;
    });
    const key = await saved().send({ name: 'a' }, post);
    expect(post).toHaveBeenCalledWith({ key, input: { name: 'a' } });
    expect(stored()).toBeNull();
  });

  it('연결이 끊기면 남겨 두고, 다음 요청은 저장된 키와 입력을 다시 보낸다', async () => {
    const lost = new ApiError('connection', '끊김', 0);
    await expect(saved().send({ name: 'a' }, async () => Promise.reject(lost), { key: 'first-key' })).rejects.toBe(lost);
    expect(stored()).toEqual({ key: 'first-key', input: { name: 'a' } });
    const post = vi.fn(async (pending: Pending<Input>) => pending);
    await expect(saved().send({ name: 'b' }, post)).resolves.toEqual({ key: 'first-key', input: { name: 'a' } });
    expect(stored()).toBeNull();
  });

  it('서버가 확실히 거절하면 지운다', async () => {
    const rejected = new ApiError('conflict', '충돌', 409);
    await expect(saved().send({ name: 'a' }, async () => Promise.reject(rejected))).rejects.toBe(rejected);
    expect(stored()).toBeNull();
  });

  it('답이 그 요청의 것이 아니면 남기고, 다른 키로는 지우지 않는다', async () => {
    await saved().send({ name: 'a' }, async () => ({ request_key: 'other' }), {
      key: 'mine',
      answered: (result, key) => result.request_key === key,
    });
    expect(stored()?.key).toBe('mine');
    saved().settle('other');
    expect(stored()?.key).toBe('mine');
    saved().settle('mine');
    expect(stored()).toBeNull();
  });

  it('검사를 통과하지 못한 입력도 서버가 거절하면 지워서 다음 요청을 막지 않는다', async () => {
    const rejected = new ApiError('invalid', '입력 오류', 422);
    const input = { name: 1 } as unknown as Input;
    await expect(saved().send(input, async () => Promise.reject(rejected))).rejects.toBe(rejected);
    expect(stored()).toBeNull();
    expect(saved().read()).toEqual({ pending: null, error: '' });
  });

  it('읽을 수 없는 기록은 새 요청을 막는다', async () => {
    localStorage.setItem(STORAGE, JSON.stringify({ key: 'k', input: { name: 1 } }));
    expect(saved().read()).toEqual({ pending: null, error: '읽을 수 없음' });
    const post = vi.fn();
    await expect(saved().send({ name: 'a' }, post)).rejects.toThrow('읽을 수 없음');
    expect(post).not.toHaveBeenCalled();
  });
});
