import './walking-controls.css';

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { useWorldInputScope } from 'gaesup-world';

type Direction = 'forward' | 'backward' | 'leftward' | 'rightward';
type Held = Readonly<Record<Direction, boolean>>;

const RELEASED: Held = { forward: false, backward: false, leftward: false, rightward: false };
/** Each button presses the key the character's own keyboard controller walks by. */
const BUTTONS: readonly { direction: Direction; label: string; code: string }[] = [
  { direction: 'forward', label: '앞으로', code: 'KeyW' },
  { direction: 'leftward', label: '왼쪽', code: 'KeyA' },
  { direction: 'backward', label: '뒤로', code: 'KeyS' },
  { direction: 'rightward', label: '오른쪽', code: 'KeyD' },
];
/** Touch screens, and windows as narrow as a phone's. */
export const TOUCH_QUERY = '(pointer: coarse), (max-width: 720px)';

/** Whether the page is on a touch screen (or as narrow as one), following it as it changes. */
export function useTouchScreen(): boolean {
  const [touch, setTouch] = useState(() => typeof matchMedia === 'function' && matchMedia(TOUCH_QUERY).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const media = matchMedia(TOUCH_QUERY);
    const changed = () => setTouch(media.matches);
    changed();
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  return touch;
}

/** Which direction each finger (or an Enter on a button) holds: letting one go never lets another go. */
function createHolds() {
  const holds = new Map<number, Direction>();
  const listeners = new Set<() => void>();
  let held: Held = RELEASED;
  const publish = () => {
    const next = { ...RELEASED };
    for (const direction of holds.values()) next[direction] = true;
    if (BUTTONS.every(({ direction }) => next[direction] === held[direction])) return;
    held = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    press(direction: Direction, pointer: number) {
      holds.set(pointer, direction);
      publish();
    },
    release(pointer: number) {
      if (holds.delete(pointer)) publish();
    },
    reset() {
      holds.clear();
      publish();
    },
    get: (): Held => held,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * Four buttons that walk the character as its keys do: each held button presses its key in the world's own input (a
 * key of its own, so a finger letting go never lets go of a key held on a keyboard, nor the other way round). Every
 * finger holds its own button; all are let go when the window or the tab loses focus, when `disabled`, and when it goes.
 */
function DirectionPad({ disabled, placement }: { disabled: boolean; placement: 'island' | 'game' }) {
  const scope = useWorldInputScope();
  const source = `walking:${useId()}`;
  const pad = useRef<HTMLDivElement>(null);
  const holds = useMemo(createHolds, []);
  const held = useSyncExternalStore(holds.subscribe, holds.get, holds.get);
  useEffect(() => {
    let pressed = RELEASED;
    const send = () => {
      const next = holds.get();
      const before = pressed;
      pressed = next;
      for (const { direction, code } of BUTTONS) {
        if (next[direction] !== before[direction]) scope.dispatchKey(next[direction] ? 'keydown' : 'keyup', code, source);
      }
    };
    const stop = holds.subscribe(send);
    // The buttons are the world's own surface, so a press on one keeps the keyboard with this world.
    const surface = pad.current ? scope.registerSurface(pad.current) : () => {};
    const release = (event: PointerEvent) => holds.release(event.pointerId);
    const reset = () => holds.reset();
    const hidden = () => {
      if (document.hidden) reset();
    };
    const blurred = scope.onBlur(reset);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      reset();
      stop();
      blurred();
      surface();
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [holds, scope, source]);
  useEffect(() => {
    if (disabled) holds.reset();
  }, [disabled, holds]);
  return (
    <div ref={pad} className="mg-walking-controls" data-placement={placement} role="group" aria-label="이동">
      {BUTTONS.map(({ direction, label }, index) => (
        <button
          key={direction}
          type="button"
          className="mg-walking-control mg-glass"
          data-direction={direction}
          aria-label={label}
          aria-pressed={held[direction]}
          disabled={disabled}
          onPointerDown={(event) => {
            if (disabled || event.button !== 0) return;
            event.preventDefault();
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // The window's listeners let go of a finger the button could not capture.
            }
            holds.press(direction, event.pointerId);
          }}
          onPointerUp={(event) => holds.release(event.pointerId)}
          onPointerCancel={(event) => holds.release(event.pointerId)}
          onLostPointerCapture={(event) => holds.release(event.pointerId)}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (disabled || event.key !== 'Enter') return;
            event.preventDefault();
            holds.press(direction, -index - 1);
          }}
          onKeyUp={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            holds.release(-index - 1);
          }}
          onBlur={() => holds.release(-index - 1)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 6l7 10H5z" />
          </svg>
        </button>
      ))}
    </div>
  );
}

/**
 * A walking pad on touch screens: on the island, and on a game's map that has taken its place (`placement="game"`,
 * against the screen's edge, as the island's own bars are gone then). Nothing elsewhere.
 */
export function WalkingControls({ disabled = false, placement = 'island' }: { disabled?: boolean; placement?: 'island' | 'game' }) {
  return useTouchScreen() ? <DirectionPad disabled={disabled} placement={placement} /> : null;
}
