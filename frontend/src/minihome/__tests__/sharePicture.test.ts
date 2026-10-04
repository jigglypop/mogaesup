import { afterEach, describe, expect, it, vi } from 'vitest';

import { photoCropPixels } from '../../character/photo-preparation';
import {
  captureIsland,
  drawPreview,
  encodeThumbnail,
  isBlank,
  PictureError,
  previewCrop,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_WIDTH,
  thumbnailFromFile,
} from '../sharePicture';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A 2D context that records what is drawn and reads back `pixels` (RGBA). */
function fakeContext(pixels = new Uint8ClampedArray(THUMBNAIL_WIDTH * THUMBNAIL_HEIGHT * 4)) {
  const context = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
    imageSmoothingQuality: 'low',
    getImageData: vi.fn(() => ({ data: pixels })),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  return context;
}

/** JPEGs of `sizes` bytes, one per call, quality by quality. */
function fakeEncoder(...sizes: number[]) {
  return vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    callback(new Blob([new Uint8Array(sizes.shift() ?? 1)], { type: 'image/jpeg' }));
  });
}

describe('공유 사진 자르기', () => {
  it('미리보기 모양(1200×630)으로 가운데를 잘라 쓴다', () => {
    const shape = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT;
    for (const [width, height] of [[4000, 3000], [1080, 1920], [3000, 1000], [1200, 630]] as const) {
      const area = photoCropPixels(width, height, previewCrop(width, height));
      expect(Math.abs(area.width / area.height - shape)).toBeLessThan(0.01);
      // Centred: as much is left out on either side.
      expect(Math.abs(area.x * 2 + area.width - width)).toBeLessThanOrEqual(1);
      expect(Math.abs(area.y * 2 + area.height - height)).toBeLessThanOrEqual(1);
    }
    expect(photoCropPixels(4000, 3000, previewCrop(4000, 3000))).toMatchObject({ x: 0, y: 450, width: 4000, height: 2100 });
  });

  it('잘라 낸 곳을 1200×630 캔버스에 채우고, 비치는 곳은 흰 바탕으로 둔다', () => {
    const context = fakeContext();
    const source = document.createElement('canvas');
    const canvas = drawPreview(source, 2000, 2000);
    expect([canvas.width, canvas.height]).toEqual([1200, 630]);
    expect(context.fillStyle).toBe('#ffffff');
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1200, 630);
    expect(context.drawImage).toHaveBeenCalledWith(source, 0, 475, 2000, 1050, 0, 0, 1200, 630);
    context.fillRect.mockClear();
    drawPreview(source, 2000, 2000, false);
    expect(context.fillRect).not.toHaveBeenCalled();
  });
});

describe('공유 사진 JPEG', () => {
  it('600KB 안에 들 때까지 품질을 낮춰 JPEG로 만든다', async () => {
    const encode = fakeEncoder(THUMBNAIL_MAX_BYTES + 1, THUMBNAIL_MAX_BYTES + 1, 400_000);
    const blob = await encodeThumbnail(document.createElement('canvas'));
    expect(blob.size).toBe(400_000);
    expect(encode.mock.calls.map(([, type, quality]) => [type, quality])).toEqual([
      ['image/jpeg', 0.86],
      ['image/jpeg', 0.78],
      ['image/jpeg', 0.7],
    ]);
  });

  it('가장 낮은 품질로도 크면 올리지 않는다', async () => {
    fakeEncoder(...Array<number>(5).fill(THUMBNAIL_MAX_BYTES + 1));
    await expect(encodeThumbnail(document.createElement('canvas'))).rejects.toThrow(PictureError);
  });

  it('고른 파일은 방향을 맞춰 읽고 잘라 JPEG data URL로 만든다', async () => {
    const close = vi.fn();
    const bitmap = { width: 3000, height: 2000, close };
    const decode = vi.fn(async () => bitmap);
    vi.stubGlobal('createImageBitmap', decode);
    const context = fakeContext();
    fakeEncoder(1234);
    const file = new File(['photo'], 'island.jpg', { type: 'image/jpeg' });
    const url = await thumbnailFromFile(file);
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(decode).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 213, 3000, 1575, 0, 0, 1200, 630);
    expect(close).toHaveBeenCalledOnce();
  });

  it('읽을 수 없는 파일은 이유를 말로 알린다', async () => {
    await expect(thumbnailFromFile(new File(['x'], 'a.gif', { type: 'image/gif' }))).rejects.toThrow('PNG 또는 JPEG');
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new DOMException('The source image could not be decoded.', 'InvalidStateError'); }));
    await expect(thumbnailFromFile(new File(['x'], 'a.png', { type: 'image/png' }))).rejects.toThrow('사진을 읽지 못했어요.');
  });
});

describe('섬 화면 담기', () => {
  const island = () => Object.assign(document.createElement('canvas'), { width: 1920, height: 1080 });
  const drawn = () => {
    const pixels = new Uint8ClampedArray(THUMBNAIL_WIDTH * THUMBNAIL_HEIGHT * 4);
    for (let at = 0; at < pixels.length; at++) pixels[at] = (at * 7) % 256;
    return pixels;
  };

  it('다음 프레임을 그린 바로 뒤에 같은 차례에서 캔버스를 옮겨 담는다', async () => {
    const context = fakeContext(drawn());
    fakeEncoder(2048);
    const effects = new Set<() => void>();
    const afterFrame = vi.fn((callback: () => void) => {
      effects.add(callback);
      return () => effects.delete(callback);
    });
    const redraw = vi.fn();
    const canvas = island();
    const taken = captureIsland(canvas, afterFrame, redraw);
    expect(redraw).toHaveBeenCalledOnce();
    // Nothing is read before the frame is drawn.
    expect(context.drawImage).not.toHaveBeenCalled();
    for (const effect of [...effects]) effect();
    expect(context.drawImage).toHaveBeenCalledWith(canvas, 0, 36, 1920, 1008, 0, 0, 1200, 630);
    expect(effects.size).toBe(0);
    await expect(taken).resolves.toMatch(/^data:image\/jpeg;base64,/);
  });

  it('한 빛깔로 비어 읽히면 보내지 않는다', async () => {
    fakeContext(new Uint8ClampedArray(THUMBNAIL_WIDTH * THUMBNAIL_HEIGHT * 4));
    const encode = fakeEncoder(2048);
    const taken = captureIsland(island(), (callback) => { queueMicrotask(callback); return () => {}; }, () => {});
    await expect(taken).rejects.toThrow('섬 화면을 담지 못했어요.');
    expect(encode).not.toHaveBeenCalled();
  });

  it('프레임이 그려지지 않으면(숨은 탭) 기다리다 그만둔다', async () => {
    vi.useFakeTimers();
    fakeContext(drawn());
    const stop = vi.fn();
    const taken = captureIsland(island(), () => stop, () => {});
    const failed = expect(taken).rejects.toThrow(PictureError);
    await vi.advanceTimersByTimeAsync(3_000);
    await failed;
    expect(stop).toHaveBeenCalledOnce();
  });

  it('빈 화면 판정은 한 빛깔인지만 본다', () => {
    fakeContext(drawn());
    expect(isBlank(document.createElement('canvas'))).toBe(false);
    fakeContext(new Uint8ClampedArray(THUMBNAIL_WIDTH * THUMBNAIL_HEIGHT * 4).fill(255));
    expect(isBlank(document.createElement('canvas'))).toBe(true);
  });
});
