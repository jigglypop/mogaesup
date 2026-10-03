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

export async function decodePhoto(file: File): Promise<DecodedPhoto> {
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('PNG 또는 JPEG 사진을 선택해 주세요.');
  if (file.size > 25 * 1024 * 1024) throw new Error('사진은 25MB 이하로 준비해 주세요.');
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
  if (!photo.width || !photo.height || photo.width * photo.height > 32_000_000) {
    photo.close(); throw new Error('사진은 3200만 픽셀 이하로 준비해 주세요.');
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
