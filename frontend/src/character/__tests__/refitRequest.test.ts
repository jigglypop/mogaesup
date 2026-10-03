import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PendingRequestConflict } from '../api';
import { factoryApi } from '../factory/api';

const JOB = 'top-job';
const STORAGE = `gaesup.part-refit:${JOB}`;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const stored = () => JSON.parse(localStorage.getItem(STORAGE) ?? 'null') as { key: string; input: Record<string, unknown> } | null;
const keyOf = (call: Parameters<typeof fetch> | undefined) => new Headers(call?.[1]?.headers).get('Idempotency-Key');
const bodyOf = (call: Parameters<typeof fetch> | undefined) => JSON.parse(String(call?.[1]?.body));

describe('파츠 다시 맞추기 요청 기록', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  const rebuild = (hem: number) => factoryApi.refitPart(JOB, 'v1', 'top', undefined, 'body_shell', { hem, fit: 'normal' });

  it('보내기 전에 저장하고, 답을 받으면 지운다', async () => {
    fetchMock.mockImplementationOnce(async (_url, init) => {
      expect(stored()?.key).toBe(new Headers(init?.headers).get('Idempotency-Key'));
      return json(200, { status: 'accepted', artifacts: [], parts: [] });
    });
    await rebuild(0.5);
    expect(stored()).toBeNull();
  });

  it('답을 잃은 뒤 같은 모양을 다시 보내면 같은 키로 보낸다', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await rebuild(0.5).catch(() => undefined);
    const saved = stored()!;
    fetchMock.mockResolvedValueOnce(json(200, { status: 'accepted', artifacts: [], parts: [] }));
    await rebuild(0.5);
    expect(keyOf(fetchMock.mock.calls[1])).toBe(saved.key);
    expect(stored()).toBeNull();
  });

  it('답을 잃은 요청이 있을 때 다른 모양은 저장된 것으로 바꿔 보내지 않고 거절한다', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await rebuild(0.5).catch(() => undefined);
    const saved = stored()!;
    fetchMock.mockClear();
    const refused = await rebuild(0.9).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PendingRequestConflict);
    expect((refused as PendingRequestConflict).pending).toEqual(saved);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stored()).toEqual(saved);
  });

  it('저장된 요청은 그 입력과 키 그대로 이어서 보낸다', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await rebuild(0.3).catch(() => undefined);
    const saved = stored()!;
    fetchMock.mockResolvedValueOnce(json(200, { status: 'accepted', artifacts: [], parts: [] }));
    await factoryApi.resumeRefit(JOB);
    expect(keyOf(fetchMock.mock.calls[1])).toBe(saved.key);
    expect(bodyOf(fetchMock.mock.calls[1])).toEqual(saved.input);
    expect(stored()).toBeNull();
  });

  it('지운 요청 뒤에는 새 모양을 새 키로 보낸다', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await rebuild(0.3).catch(() => undefined);
    const saved = stored()!;
    factoryApi.acknowledgeRefit(JOB, saved.key);
    fetchMock.mockResolvedValueOnce(json(200, { status: 'accepted', artifacts: [], parts: [] }));
    await rebuild(0.9);
    expect(keyOf(fetchMock.mock.calls[1])).not.toBe(saved.key);
    expect(bodyOf(fetchMock.mock.calls[1]).shape).toEqual({ hem: 0.9, fit: 'normal' });
  });
});
