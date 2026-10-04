import { addAfterEffect, invalidate } from '@react-three/fiber';

import { decodePhoto, photoCropPixels, type PhotoCrop } from '../character/photo-preparation';

/** The link preview's picture, as the server keeps it (`server/src/share.rs`). */
export const THUMBNAIL_WIDTH = 1200;
export const THUMBNAIL_HEIGHT = 630;
/** The JPEG sent at most; the server takes up to 1 MiB. */
export const THUMBNAIL_MAX_BYTES = 600 * 1024;
/** JPEG qualities tried in turn until the picture fits. */
const QUALITIES = [0.86, 0.78, 0.7, 0.6, 0.5] as const;
/** How long a capture waits for the island to draw a frame (a hidden tab draws none). */
const CAPTURE_WAIT_MS = 3_000;
const NOT_CAPTURED = '섬 화면을 담지 못했어요.';

/** A picture this page could not read or make; its message is for the owner. */
export class PictureError extends Error {}

/** The middle of a `width`×`height` picture in the preview's shape, as a crop of the whole. */
export function previewCrop(width: number, height: number): PhotoCrop {
  const shape = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT;
  if (width / height > shape) {
    const part = (height * shape) / width;
    return { x: (1 - part) / 2, y: 0, width: part, height: 1 };
  }
  const part = width / shape / height;
  return { x: 0, y: (1 - part) / 2, width: 1, height: part };
}

/**
 * `source` (`width`×`height` px) cropped to its middle and scaled to fill a new preview-sized canvas; on white where it
 * is see-through when `background` is set, as the server does.
 */
export function drawPreview(source: CanvasImageSource, width: number, height: number, background = true): HTMLCanvasElement {
  const area = photoCropPixels(width, height, previewCrop(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = THUMBNAIL_WIDTH;
  canvas.height = THUMBNAIL_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new PictureError('사진을 만들지 못했어요.');
  if (background) {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  }
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, area.x, area.y, area.width, area.height, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  return canvas;
}

/** Whether `canvas` holds one flat colour: what a frame read back after the screen took it gives (clear or black). */
export function isBlank(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext('2d');
  if (!context) return true;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  // A sparse sample is enough to tell a drawn island from an empty buffer.
  const step = 4 * 97;
  for (let at = step; at < data.length; at += step) {
    if (data[at] !== data[0] || data[at + 1] !== data[1] || data[at + 2] !== data[2] || data[at + 3] !== data[3]) return false;
  }
  return true;
}

/** `canvas` as a JPEG within {@link THUMBNAIL_MAX_BYTES}, at the best quality that fits. */
export async function encodeThumbnail(canvas: HTMLCanvasElement): Promise<Blob> {
  for (const quality of QUALITIES) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new PictureError('사진을 만들지 못했어요.');
    if (blob.size <= THUMBNAIL_MAX_BYTES) return blob;
  }
  throw new PictureError('사진이 너무 커요.');
}

/** `blob` as a data URL, the way the server takes a picture. */
export function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new PictureError('사진을 읽지 못했어요.'));
    reader.readAsDataURL(blob);
  });
}

/** A PNG or JPEG file as the preview's picture: its middle, 1200×630, as a JPEG data URL. */
export async function thumbnailFromFile(file: File): Promise<string> {
  const photo = await decodePhoto(file).catch((problem: unknown) => {
    // The checks say what to do in words; a decoder that gave up says it in its own.
    throw new PictureError(problem instanceof Error && !(problem instanceof DOMException) ? problem.message : '사진을 읽지 못했어요.');
  });
  try {
    return await dataUrlOf(await encodeThumbnail(drawPreview(photo.source, photo.width, photo.height)));
  } finally {
    photo.close();
  }
}

/**
 * The island as `canvas` shows it now, as the preview's picture. A WebGPU (or WebGL) canvas keeps its picture only until
 * the frame goes to the screen, so it is copied right after the next frame is drawn, in the same task; a copy that comes
 * back flat is refused rather than sent.
 */
export async function captureIsland(
  canvas: HTMLCanvasElement,
  afterFrame: (callback: () => void) => () => void = addAfterEffect,
  redraw: () => void = () => invalidate(),
): Promise<string> {
  const preview = await new Promise<HTMLCanvasElement>((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {
      stop();
      reject(new PictureError(NOT_CAPTURED));
    }, CAPTURE_WAIT_MS);
    stop = afterFrame(() => {
      stop();
      clearTimeout(timer);
      try {
        resolve(drawPreview(canvas, canvas.width, canvas.height, false));
      } catch {
        reject(new PictureError(NOT_CAPTURED));
      }
    });
    redraw();
  });
  if (isBlank(preview)) throw new PictureError(NOT_CAPTURED);
  return dataUrlOf(await encodeThumbnail(preview));
}
