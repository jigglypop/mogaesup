import type { WebGPURenderer } from 'three/webgpu';

// A village's canvas calls for some seventy pipelines in its first frames: every material as the picture, the sun's
// shadows and the darkroom's own passes draw it. Made as a frame asks for them, the graphics process builds them one
// after another and holds the frame; three's own compile (compileAsync) waits for each object's pipeline before it
// starts on the next object, five seconds on a desktop. Here, until the canvas shows, every pipeline asked for (by a
// frame or by a compile) is made in the background, all at once: the graphics process builds them side by side, a
// compile goes on to the next object at once, and what is not ready is left out of a frame drawn out of sight. The
// canvas shows once a few frames in a row have asked for nothing still being made (Stage's Ready). Going to another
// 섬 keeps the canvas and makes its new pipelines so again, until it shows that one.

type Backend = { createRenderPipeline: (renderObject: { material?: { name?: string } }, promises: Promise<unknown>[] | null) => void };

/**
 * What is drawn once and kept, not drawn again every frame: the sky's light worked out into the scene's environment
 * (three's PMREM generator names its materials so). Left out of the frame that drew it, it would stay dark for good.
 */
const once = (renderObject: { material?: { name?: string } }) => renderObject.material?.name?.startsWith('PMREM') === true;

export type Making = {
  /** Pipelines asked for and not made yet. */
  readonly pending: number;
  /** Pipelines asked for in the background since it began, or last resumed. */
  readonly total: number;
  /** Makes the pipelines asked for from now on as three does (at once, holding the frame): once the canvas shows. */
  stop: () => void;
  /** Makes them in the background again: while the canvas is out of sight. */
  resume: () => void;
};

const makings = new WeakMap<object, Making>();

/** Starts making `renderer`'s pipelines in the background (see above); a second call gives back the first's. */
export function makeInBackground(renderer: WebGPURenderer): Making {
  const known = makings.get(renderer);
  if (known) return known;
  const backend = renderer.backend as unknown as Backend;
  const make = backend.createRenderPipeline;
  let pending = 0;
  let total = 0;
  const settle = () => {
    pending -= 1;
  };
  const inBackground: Backend['createRenderPipeline'] = (renderObject, promises) => {
    if (once(renderObject)) return make.call(backend, renderObject, promises);
    const made: Promise<unknown>[] = [];
    make.call(backend, renderObject, made);
    for (const promise of made) {
      pending += 1;
      total += 1;
      promise.then(settle, settle);
    }
  };
  backend.createRenderPipeline = inBackground;
  const making: Making = {
    get pending() {
      return pending;
    },
    get total() {
      return total;
    },
    stop: () => {
      backend.createRenderPipeline = make;
    },
    resume: () => {
      total = pending;
      backend.createRenderPipeline = inBackground;
    },
  };
  makings.set(renderer, making);
  return making;
}

/** What `renderer` is making in the background, if it was started (see {@link makeInBackground}). */
export const makingOf = (renderer: unknown): Making | null => makings.get(renderer as object) ?? null;
