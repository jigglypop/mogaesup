import { ModelViewer } from './viewer';

/** A part's still picture, and the backend that drew it (`webgpu`, or `webgl-fallback` for the compatible renderer). */
export type Thumbnail = { src: string; renderer: string };

/** The picture's size in CSS pixels; the viewer draws it at up to 1.5x. */
const SIZE = 192;
/** How long the drawing viewer stays after the last picture, for the next card that asks. */
const IDLE_MS = 2000;
/** Pictures kept for cards that come back (another slot, the closet opened again). */
const KEEP = 48;

type Job = { url: string; sha256: string; resolve(value: Thumbnail): void; reject(reason: unknown): void };
const drawn = new Map<string, Thumbnail>();
const queue: Job[] = [];
let drawing = false;
let viewer: ModelViewer | null = null, stage: HTMLElement | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;

const identity = (url: string, sha256: string) => `${url}#${sha256}`;
const unwanted = () => new DOMException('The picture is no longer wanted', 'AbortError');

/** Whether this browser can draw a picture at all: WebGPU, or WebGL 2 for the compatible renderer. */
export const canDrawThumbnails = () => typeof navigator !== 'undefined' && ('gpu' in navigator || typeof WebGL2RenderingContext !== 'undefined');

/**
 * A still picture of a part's model, for a card that has no drawing of it. One offscreen viewer draws the pictures one
 * at a time, so every card shares a single GPU device, and it is let go shortly after the queue empties. A card that
 * goes away aborts `signal`: its picture leaves the queue unless it is already being drawn.
 */
export function partThumbnail(url: string, sha256: string, signal: AbortSignal): Promise<Thumbnail> {
  const known = drawn.get(identity(url, sha256));
  if (known) return Promise.resolve(known);
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(unwanted()); return; }
    const job: Job = { url, sha256, resolve, reject };
    queue.push(job);
    signal.addEventListener('abort', () => {
      const index = queue.indexOf(job);
      if (index >= 0) { queue.splice(index, 1); reject(unwanted()); }
    }, { once: true });
    void drain();
  });
}

/**
 * Resolves once the page is shown. A hidden tab draws no frames, so a picture started there would wait with the viewer
 * held; the queue waits instead, and lets the viewer go after `IDLE_MS` as an empty queue does.
 */
function shown() {
  if (typeof document === 'undefined' || !document.hidden) return Promise.resolve();
  clearTimeout(idle); idle = setTimeout(close, IDLE_MS);
  return new Promise<void>(resolve => {
    const back = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', back);
      clearTimeout(idle); resolve();
    };
    document.addEventListener('visibilitychange', back);
  });
}

async function drain() {
  if (drawing) return;
  drawing = true; clearTimeout(idle);
  try {
    while (queue.length) {
      await shown();
      const job = queue.shift();
      if (!job) break;
      const key = identity(job.url, job.sha256);
      try {
        const picture = drawn.get(key) ?? await draw(job);
        keep(key, picture);
        job.resolve(picture);
      } catch (error) {
        // A viewer that failed once is not trusted with the next part.
        close();
        job.reject(error);
      }
    }
  } finally {
    drawing = false;
    idle = setTimeout(close, IDLE_MS);
  }
}

async function draw(job: Job) {
  if (!viewer) {
    stage = document.createElement('div');
    stage.setAttribute('aria-hidden', 'true');
    stage.style.cssText = `position:fixed;left:-10000px;top:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden;pointer-events:none`;
    document.body.append(stage);
    viewer = new ModelViewer(stage, 'card');
  }
  // Loading the next part lets go of the previous one's GPU resources (the viewer retires it once this one is ready).
  await viewer.load(job.url, { sha256: job.sha256 });
  return viewer.snapshot();
}

function close() {
  clearTimeout(idle);
  viewer?.dispose(); viewer = null;
  stage?.remove(); stage = null;
}

function keep(key: string, picture: Thumbnail) {
  drawn.delete(key); drawn.set(key, picture);
  while (drawn.size > KEEP) drawn.delete(drawn.keys().next().value!);
}
