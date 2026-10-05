export type PhotoCrop = { x: number; y: number; width: number; height: number };
export type DecodedPhoto = { source: CanvasImageSource; width: number; height: number; close(): void };
export const FULL_PHOTO: PhotoCrop = { x: 0, y: 0, width: 1, height: 1 };
export const PHOTO_MAX_EDGE = 2048;

export function photoCropPixels(width: number, height: number, crop: PhotoCrop) {
  if (![width, height].every(value => Number.isInteger(value) && value > 0)
    || ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
    || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
    || crop.x + crop.width > 1 + 1e-9 || crop.y + crop.height > 1 + 1e-9) {
    throw new Error('사진 자르기 영역을 확인해 주세요.');
  }
  const x = Math.min(width - 1, Math.round(crop.x * width)), y = Math.min(height - 1, Math.round(crop.y * height));
  const croppedWidth = Math.max(1, Math.min(width - x, Math.round(crop.width * width)));
  const croppedHeight = Math.max(1, Math.min(height - y, Math.round(crop.height * height)));
  const ratio = Math.min(1, PHOTO_MAX_EDGE / Math.max(croppedWidth, croppedHeight));
  return { x, y, width: croppedWidth, height: croppedHeight,
    outputWidth: Math.max(1, Math.round(croppedWidth * ratio)), outputHeight: Math.max(1, Math.round(croppedHeight * ratio)) };
}

/** The most pixels a photo may have; a decoder would hold them all in memory at once. */
export const PHOTO_MAX_PIXELS = 32_000_000;
const tooLarge = () => new Error('사진은 3200만 픽셀 이하로 준비해 주세요.');

/** JPEG start-of-frame markers (C0-CF but DHT C4, JPG C8 and DAC CC) carry the frame's height and width. */
const isStartOfFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/**
 * The width and height a PNG (IHDR) or JPEG (start of frame) header states, read from the file's bytes before anything
 * decodes it; null when the header cannot be read, and the decoder is left to judge the file.
 */
export async function photoHeaderSize(file: Blob): Promise<{ width: number; height: number } | null> {
  const bytes = new Uint8Array(typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  }));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(12) === 0x49484452) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  for (let at = 2; at + 4 <= bytes.length;) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    // Fill bytes, and markers that stand alone without a length.
    if (marker === 0xff) { at++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = view.getUint16(at + 2);
    if (length < 2) return null;
    if (isStartOfFrame(marker)) return at + 9 <= bytes.length ? { width: view.getUint16(at + 7), height: view.getUint16(at + 5) } : null;
    at += 2 + length;
  }
  return null;
}

export async function decodePhoto(file: File): Promise<DecodedPhoto> {
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('PNG 또는 JPEG 사진을 선택해 주세요.');
  if (file.size > 25 * 1024 * 1024) throw new Error('사진은 25MB 이하로 준비해 주세요.');
  // A small file can still hold a huge picture; it is refused before decoding would hold every pixel.
  const stated = await photoHeaderSize(file).catch(() => null);
  if (stated && stated.width * stated.height > PHOTO_MAX_PIXELS) throw tooLarge();
  let photo: DecodedPhoto;
  if (typeof createImageBitmap === 'function') {
    // The decoder applies EXIF orientation once. Canvas re-encoding drops the source metadata.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    photo = { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  } else {
    const url = URL.createObjectURL(file), element = new Image();
    try {
      await new Promise<void>((resolve, reject) => { element.onload = () => resolve(); element.onerror = () => reject(new Error('사진을 읽지 못했습니다.')); element.src = url; });
      photo = { source: element, width: element.naturalWidth, height: element.naturalHeight, close: () => URL.revokeObjectURL(url) };
    } catch (error) { URL.revokeObjectURL(url); throw error; }
  }
  if (!photo.width || !photo.height || photo.width * photo.height > PHOTO_MAX_PIXELS) {
    photo.close(); throw tooLarge();
  }
  return photo;
}

export async function preparePhoto(photo: DecodedPhoto, file: File, crop: PhotoCrop): Promise<{ file: File; width: number; height: number }> {
  const area = photoCropPixels(photo.width, photo.height, crop);
  const canvas = document.createElement('canvas');
  canvas.width = area.outputWidth; canvas.height = area.outputHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('사진 편집을 시작하지 못했습니다.');
  context.drawImage(photo.source, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
  const mime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('사진을 저장하지 못했습니다.')), mime, .9));
  return { file: new File([blob], file.name.replace(/\.[^.]+$/, '') + (mime === 'image/jpeg' ? '.jpg' : '.png'), { type: mime }), width: canvas.width, height: canvas.height };
}
