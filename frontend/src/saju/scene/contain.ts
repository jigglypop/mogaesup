/** The largest size of `image` that sits inside `frame` without stretching either side. */
export function containedSize(imageW: number, imageH: number, frameW: number, frameH: number): { w: number; h: number } {
  if (imageW <= 0 || imageH <= 0 || frameW <= 0 || frameH <= 0) return { w: frameW, h: frameH };
  const scale = Math.min(frameW / imageW, frameH / imageH);
  return { w: imageW * scale, h: imageH * scale };
}
