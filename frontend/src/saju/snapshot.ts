/** The saved picture: a square, this many pixels a side. */
export const PICTURE_SIZE = 1080;

export type PictureCaption = {
  /** `노을의 집`. */
  title: string;
  /** The line under it: the day master's badge. */
  line: string;
  /** The element's colour, for the mark beside the title. */
  mark: string;
  ink: string;
  muted: string;
  font: string;
};

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

/** `text` cut to fit `width`, ending in an ellipsis when it was cut. */
function fitted(context: CanvasRenderingContext2D, text: string, width: number): string {
  if (context.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && context.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * The picture a home is saved as: the home on its island in the lake as `home` drew it (a square canvas), a dotted
 * frame and a name plate along the bottom.
 */
export function composePicture(home: CanvasImageSource, caption: PictureCaption): HTMLCanvasElement {
  const size = PICTURE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas is not available');
  context.drawImage(home, 0, 0, size, size);

  context.setLineDash([4, 14]);
  context.lineWidth = 5;
  context.lineCap = 'round';
  context.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  roundedRect(context, 30, 30, size - 60, size - 60, 40);
  context.stroke();
  context.setLineDash([]);

  const plate = { x: 70, y: size - 208, width: size - 140, height: 138 };
  context.fillStyle = 'rgba(255, 255, 255, 0.9)';
  roundedRect(context, plate.x, plate.y, plate.width, plate.height, 30);
  context.fill();
  context.fillStyle = caption.mark;
  roundedRect(context, plate.x + 30, plate.y + 33, 20, 72, 8);
  context.fill();
  const text = plate.width - 106;
  context.textBaseline = 'alphabetic';
  context.fillStyle = caption.ink;
  context.font = `800 46px ${caption.font}`;
  context.fillText(fitted(context, caption.title, text), plate.x + 74, plate.y + 62);
  context.fillStyle = caption.muted;
  context.font = `650 30px ${caption.font}`;
  context.fillText(fitted(context, caption.line, text), plate.x + 74, plate.y + 108);
  return canvas;
}

/** A file name a home's picture is saved under: the name with what a file system would refuse taken out. */
export function pictureFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
  return `${safe || '사주'}-집.png`;
}

/** Hands `blob` to the browser to save as `fileName`. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // The download reads the URL after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
