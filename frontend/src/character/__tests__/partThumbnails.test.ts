import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

type Deferred = { url: string; finish: () => void; fail: (error: Error) => void };
// The viewer is not what is tested: each load waits for the test, and a picture names the model it was taken of.
const viewers = vi.hoisted(() => [] as { container: HTMLElement; loads: Deferred[]; dispose: Mock }[]);
vi.mock('../viewer', () => ({
  ModelViewer: class {
    loads: Deferred[] = [];
    current = '';
    dispose = vi.fn();
    container: HTMLElement;
    constructor(container: HTMLElement) { this.container = container; viewers.push(this); }
    load(url: string) {
      return new Promise<{ index: number; name: string }[]>((resolve, reject) => {
        this.loads.push({ url, finish: () => { this.current = url; resolve([]); }, fail: reject });
      });
    }
    async snapshot() { return { src: `data:image/webp;base64,${this.current}`, renderer: 'webgpu' }; }
  },
}));

const flush = () => vi.advanceTimersByTimeAsync(0);
let thumbnails: typeof import('../part-thumbnails');

describe('파츠 모델 그림', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    viewers.length = 0;
    // A fresh queue and picture cache for each case.
    vi.resetModules();
    thumbnails = await import('../part-thumbnails');
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });
  const wanted = () => new AbortController();

  it('한 번에 하나씩, 화면 밖의 뷰어 하나로 그린다', async () => {
    const first = thumbnails.partThumbnail('/a.glb', 'a', wanted().signal);
    const second = thumbnails.partThumbnail('/b.glb', 'b', wanted().signal);
    await flush();
    expect(viewers).toHaveLength(1);
    expect(viewers[0]!.loads.map(load => load.url)).toEqual(['/a.glb']);
    expect(viewers[0]!.container.isConnected).toBe(true);
    expect(viewers[0]!.container.getAttribute('aria-hidden')).toBe('true');
    viewers[0]!.loads[0]!.finish();
    await expect(first).resolves.toEqual({ src: 'data:image/webp;base64,/a.glb', renderer: 'webgpu' });
    await flush();
    expect(viewers[0]!.loads.map(load => load.url)).toEqual(['/a.glb', '/b.glb']);
    viewers[0]!.loads[1]!.finish();
    await expect(second).resolves.toMatchObject({ src: 'data:image/webp;base64,/b.glb' });
    expect(viewers).toHaveLength(1);
  });

  it('한 번 그린 그림은 다시 그리지 않는다', async () => {
    const first = thumbnails.partThumbnail('/a.glb', 'a', wanted().signal);
    await flush();
    viewers[0]!.loads[0]!.finish();
    await first;
    await expect(thumbnails.partThumbnail('/a.glb', 'a', wanted().signal)).resolves.toMatchObject({ src: 'data:image/webp;base64,/a.glb' });
    expect(viewers[0]!.loads).toHaveLength(1);
  });

  it('줄이 비면 잠시 뒤 뷰어와 그 자리를 놓고, 다음 그림은 새 뷰어가 그린다', async () => {
    const first = thumbnails.partThumbnail('/a.glb', 'a', wanted().signal);
    await flush();
    viewers[0]!.loads[0]!.finish();
    await first;
    expect(viewers[0]!.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(viewers[0]!.dispose).toHaveBeenCalledOnce();
    expect(viewers[0]!.container.isConnected).toBe(false);
    void thumbnails.partThumbnail('/b.glb', 'b', wanted().signal);
    await flush();
    expect(viewers).toHaveLength(2);
  });

  it('카드가 사라지면 아직 기다리던 그림은 줄에서 빠지고 그리지 않는다', async () => {
    const first = thumbnails.partThumbnail('/a.glb', 'a', wanted().signal);
    const gone = wanted();
    const second = thumbnails.partThumbnail('/b.glb', 'b', gone.signal).catch((error: Error) => error);
    await flush();
    gone.abort();
    expect((await second as Error).name).toBe('AbortError');
    viewers[0]!.loads[0]!.finish();
    await first;
    await flush();
    expect(viewers[0]!.loads.map(load => load.url)).toEqual(['/a.glb']);
  });

  it('그리다 실패하면 그 뷰어를 놓고 다음 파츠는 새 뷰어로 그린다', async () => {
    const broken = thumbnails.partThumbnail('/broken.glb', 'x', wanted().signal).catch((error: Error) => error);
    const next = thumbnails.partThumbnail('/b.glb', 'b', wanted().signal);
    await flush();
    viewers[0]!.loads[0]!.fail(new Error('모델 파일을 불러올 수 없습니다.'));
    expect((await broken as Error).message).toBe('모델 파일을 불러올 수 없습니다.');
    expect(viewers[0]!.dispose).toHaveBeenCalledOnce();
    await flush();
    expect(viewers).toHaveLength(2);
    viewers[1]!.loads[0]!.finish();
    await expect(next).resolves.toMatchObject({ src: 'data:image/webp;base64,/b.glb' });
  });

  it('GPU가 없는 곳에서는 그릴 수 없다고 알린다', () => {
    expect(thumbnails.canDrawThumbnails()).toBe(false);
  });
});
