import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadBytes } from '../assets/download';
import { loadFailure } from '../assets/load-failure';

/** A body the test feeds piece by piece, and whether the download let go of it. */
function body() {
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start: (controller) => { feed = controller; }, cancel: cancelled });
  return { stream, cancelled, push: (...bytes: number[]) => feed.enqueue(new Uint8Array(bytes)), end: () => feed.close() };
}
const bytesOf = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)];
const failureOf = (download: Promise<unknown>) => download.then(() => null, (error: unknown) => error as Error);
const options = { refused: '모델 파일을 불러올 수 없습니다.', answerMs: 1000, stallMs: 1000 };

describe('모델 파일 받기', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('큰 파일은 조각이 계속 오는 한 전체 시간이 길어도 끝까지 받는다', async () => {
    const source = body();
    fetchMock.mockResolvedValue(new Response(source.stream));
    const download = downloadBytes('/model.glb', options);
    for (let piece = 0; piece < 12; piece++) {
      await vi.advanceTimersByTimeAsync(800);
      source.push(piece);
    }
    source.end();
    expect(bytesOf(await download)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('서버가 제때 답하지 않으면 시간 초과로 실패한다', async () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    const failed = failureOf(downloadBytes('/model.glb', options));
    await vi.advanceTimersByTimeAsync(1000);
    const error = await failed;
    expect(error?.name).toBe('TimeoutError');
    expect(loadFailure(error, '모델 파일').message).toBe('모델 파일 불러오기 시간이 초과되었습니다.');
  });

  it('받는 도중 조각이 끊기면 시간 초과로 실패하고 받던 것을 놓는다', async () => {
    const source = body();
    fetchMock.mockResolvedValue(new Response(source.stream));
    const failed = failureOf(downloadBytes('/model.glb', options));
    await vi.advanceTimersByTimeAsync(500);
    source.push(1, 2);
    await vi.advanceTimersByTimeAsync(999);
    source.push(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await failed)?.name).toBe('TimeoutError');
    expect(source.cancelled).toHaveBeenCalled();
  });

  it('부르는 쪽이 취소하면 취소로 실패한다', async () => {
    const source = body();
    fetchMock.mockResolvedValue(new Response(source.stream));
    const controller = new AbortController();
    const failed = failureOf(downloadBytes('/model.glb', { ...options, signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(100);
    source.push(1);
    controller.abort();
    const error = await failed;
    expect(error?.name).toBe('AbortError');
    expect(loadFailure(error, '의상 모델').message).toBe('의상 모델 불러오기가 취소되었습니다.');
    expect(source.cancelled).toHaveBeenCalled();
  });

  it('파일 대신 거절이 오면 정한 문장으로 실패하고 시계를 남기지 않는다', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 404 }));
    const error = await failureOf(downloadBytes('/model.glb', options));
    expect(error?.message).toBe('모델 파일을 불러올 수 없습니다.');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('연결 실패는 브라우저가 알린 그대로 넘긴다', async () => {
    const lost = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(lost);
    expect(await failureOf(downloadBytes('/model.glb', options))).toBe(lost);
  });
});
