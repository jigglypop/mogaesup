import { useEffect, useLayoutEffect, useRef } from 'react';

import { advance, flushGlobalEffects, useThree } from '@react-three/fiber';

import { createIdleFrameGate, useCanvasFrameScheduler, useInputBackend } from 'gaesup-world';

/** Input that keeps the canvas drawing every display frame. */
const ACTIVITY = ['pointerdown', 'pointermove', 'wheel', 'keydown', 'keyup', 'touchstart', 'touchmove'] as const;

/**
 * How far a camera matrix element may drift and still count as standing still. The engine's follow camera slerps
 * toward its target every frame and, settled, keeps flipping the last bit of its rotation (about 1e-16), which an
 * exact comparison reads as a moving camera: the idle island then drew every frame. 1e-6 is far below a visible change.
 */
export const CAMERA_STILL = 1e-6;

/** Whether `elements` moved away from `seen` by more than `tolerance` in any element. */
export function cameraMoved(seen: ArrayLike<number>, elements: ArrayLike<number>, tolerance = CAMERA_STILL): boolean {
  for (let index = 0; index < 16; index++) if (Math.abs(elements[index]! - seen[index]!) > tolerance) return true;
  return false;
}

/**
 * gaesup-world's `IdleFrameRate` (1.7.0) with one change: the camera counts as moving only past {@link CAMERA_STILL}.
 * The engine's own can come back once it compares with a tolerance. Draws every display frame within `after` seconds of
 * input, a moving camera or walking residents, and `fps` frames a second after that. It paces the canvas itself
 * (`frameloop="never"` while mounted); simulation keeps its own clock.
 */
export function IdleFrameRate({ fps = 30, after = 2 }: { fps?: number; after?: number }) {
  const get = useThree((state) => state.get);
  const scheduler = useCanvasFrameScheduler();
  const input = useInputBackend();
  const frameloop = useThree((state) => state.frameloop);
  // Frame time drawn so far, in seconds; the canvas clock follows it.
  const elapsed = useRef(0);
  const owned = useRef(false);

  // The canvas applies its own frameloop prop again whenever it renders, and that restarts its clock.
  useLayoutEffect(() => {
    if (frameloop !== 'always') return;
    owned.current = true;
    const state = get();
    state.setFrameloop('never');
    // Frames requested before the switch would run once more in R3F's own loop with a millisecond time.
    state.internal.frames = 0;
    state.clock.elapsedTime = elapsed.current;
  }, [frameloop, get]);
  useEffect(
    () => () => {
      if (owned.current) get().setFrameloop('always');
    },
    [get],
  );

  useEffect(() => {
    const gate = createIdleFrameGate({ fps, afterMs: after * 1000 });
    const wake = () => gate.activity(performance.now());
    wake();
    let last = performance.now();
    // The camera's world matrix when it last moved; a camera still gliding after input keeps the full rate.
    const seen = new Float64Array(16);
    let request = requestAnimationFrame(function draw(time) {
      request = requestAnimationFrame(draw);
      const state = get();
      gate.activity(scheduler.getLastActivity());
      if (!owned.current || state.frameloop !== 'never' || !gate.shouldDraw(time)) return;
      const elements = state.camera.matrixWorld.elements;
      if (cameraMoved(seen, elements)) {
        seen.set(elements);
        gate.activity(time);
      }
      state.clock.elapsedTime = elapsed.current;
      elapsed.current += Math.max(0, time - last) / 1000;
      last = time;
      flushGlobalEffects('before', time);
      advance(elapsed.current, false, state);
      flushGlobalEffects('after', time);
    });
    for (const type of ACTIVITY) window.addEventListener(type, wake, { capture: true, passive: true });
    // Gamepads send no DOM events: a change the world's input sees counts too.
    const offInput = input.subscribe?.(wake);
    return () => {
      cancelAnimationFrame(request);
      for (const type of ACTIVITY) window.removeEventListener(type, wake, { capture: true });
      offInput?.();
    };
  }, [after, fps, get, input, scheduler]);

  return null;
}
