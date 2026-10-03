import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePhoto, FULL_PHOTO, photoCropPixels, preparePhoto } from '../photo-preparation';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('사진 업로드 전처리', () => {
  it('크롭 좌표와 종횡비를 유지하며 긴 변만 2048까지 줄인다', () => {
    expect(photoCropPixels(6000, 4000, { x: .1, y: .25, width: .8, height: .5 })).toEqual({ x: 600, y: 1000, width: 4800, height: 2000, outputWidth: 2048, outputHeight: 853 });
    expect(photoCropPixels(300, 500, FULL_PHOTO)).toMatchObject({ outputWidth: 300, outputHeight: 500 });
    expect(() => photoCropPixels(6000, 4000, { x: .5, y: 0, width: .8, height: 1 })).toThrow('자르기 영역');
    expect(() => photoCropPixels(6000, 4000, { ...FULL_PHOTO, x: NaN })).toThrow('자르기 영역');
  });
  it('EXIF 방향은 decoder에 한 번 적용하고 새 canvas 파일만 업로드한다', async () => {
    const source = new File(['source with metadata'], 'portrait.jpg', { type: 'image/jpeg' });
    const close = vi.fn(), bitmap = { width: 4000, height: 6000, close };
    const decode = vi.fn(async () => bitmap); vi.stubGlobal('createImageBitmap', decode);
    const draw = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
    const encoded = new Blob(['new pixels'], { type: 'image/jpeg' });
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(encoded));
    const photo = await decodePhoto(source), result = await preparePhoto(photo, source, FULL_PHOTO);
    expect(decode).toHaveBeenCalledExactlyOnceWith(source, { imageOrientation: 'from-image' });
    expect(draw).toHaveBeenCalledWith(bitmap, 0, 0, 4000, 6000, 0, 0, 1365, 2048);
    expect(encode).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', .9);
    expect(result.file).not.toBe(source); expect(result.file.size).toBe(encoded.size); expect(result.file.type).toBe('image/jpeg');
    photo.close(); expect(close).toHaveBeenCalledOnce();
  });
});
