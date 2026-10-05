import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePhoto, FULL_PHOTO, photoCropPixels, photoHeaderSize, preparePhoto } from '../photo-preparation';

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

  const png = (width: number, height: number) => {
    const bytes = new Uint8Array(33), view = new DataView(bytes.buffer);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    view.setUint32(16, width); view.setUint32(20, height);
    return bytes;
  };
  // SOI, an APP1 segment of 300 bytes, then a baseline start of frame.
  const jpeg = (width: number, height: number) => {
    const bytes = new Uint8Array(2 + 2 + 300 + 2 + 17), view = new DataView(bytes.buffer);
    bytes.set([0xff, 0xd8, 0xff, 0xe1]); view.setUint16(4, 300);
    const frame = 2 + 2 + 300;
    bytes.set([0xff, 0xc0], frame); view.setUint16(frame + 2, 17); bytes[frame + 4] = 8;
    view.setUint16(frame + 5, height); view.setUint16(frame + 7, width);
    return bytes;
  };
  it('PNG·JPEG 머리에 적힌 크기를 디코드하기 전에 읽는다', async () => {
    await expect(photoHeaderSize(new Blob([png(6000, 4000)]))).resolves.toEqual({ width: 6000, height: 4000 });
    await expect(photoHeaderSize(new Blob([jpeg(4032, 3024)]))).resolves.toEqual({ width: 4032, height: 3024 });
    await expect(photoHeaderSize(new Blob(['not a picture']))).resolves.toBeNull();
    await expect(photoHeaderSize(new Blob([jpeg(10, 10).slice(0, 40)]))).resolves.toBeNull();
  });
  it('픽셀이 너무 많은 사진은 디코드하지 않고 거절한다', async () => {
    const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
    await expect(decodePhoto(new File([png(20_000, 20_000)], 'huge.png', { type: 'image/png' }))).rejects.toThrow('3200만 픽셀');
    await expect(decodePhoto(new File([jpeg(30_000, 30_000)], 'huge.jpg', { type: 'image/jpeg' }))).rejects.toThrow('3200만 픽셀');
    expect(decode).not.toHaveBeenCalled();
  });
});
