import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TIMEOUT_MS } from '../../api/client';
import { ApiError } from '../api';
import { ANSWER_TIMEOUT_MS, downloadBytes } from '../assets/download';
import { factoryApi, type WardrobePart } from '../factory/api';

/** How long the app server may hold a member's wardrobe read before it answers: its turn, then the character server's
 * first byte (server/src/factory.rs MEMBER_WAIT + MEMBER_FIRST_BYTE). */
const SERVER_HOLDS_MS = 24_000;
const part: WardrobePart = { job_id: 'hat-job', version: 'v1', slot: 'hat', name: '모자', sha256: 'sha' };
/** Settles to the error a read failed with, or null while it is still waiting. */
const watched = (read: Promise<unknown>) => {
  let failure: unknown = null;
  read.catch((error: unknown) => { failure = error; });
  return () => failure;
};

describe('회원 옷장 읽기', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A server that has not started answering: the request waits until it is given up.
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('서버가 자리와 첫 응답을 기다리는 동안 먼저 포기하지 않는다', async () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(SERVER_HOLDS_MS);
    const reads = [factoryApi.wardrobeBodies(), factoryApi.wardrobeParts('body-job'), factoryApi.wardrobeOutfits(),
      factoryApi.wardrobeColors(part), factoryApi.wardrobeCoverage('body-job', part)].map(watched);
    await vi.advanceTimersByTimeAsync(SERVER_HOLDS_MS);
    expect(reads.map((failure) => failure())).toEqual(reads.map(() => null));
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - SERVER_HOLDS_MS);
    for (const failure of reads) {
      expect(failure()).toBeInstanceOf(ApiError);
      expect((failure() as ApiError).code).toBe('timeout');
    }
  });

  it('모델 파일도 서버의 첫 응답을 그보다 오래 기다린다', async () => {
    expect(ANSWER_TIMEOUT_MS).toBeGreaterThan(SERVER_HOLDS_MS);
    const download = watched(downloadBytes('/api/avatar-factory/jobs/hat-job/native-parts/v1/hat.glb', { refused: '의상 모델을 불러올 수 없어요.' }));
    await vi.advanceTimersByTimeAsync(SERVER_HOLDS_MS);
    expect(download()).toBeNull();
    await vi.advanceTimersByTimeAsync(ANSWER_TIMEOUT_MS - SERVER_HOLDS_MS);
    expect((download() as DOMException).name).toBe('TimeoutError');
  });
});
