import { useSyncExternalStore } from 'react';

import { KART_KEYS, type KartInput } from './physics';

export type KartControl = 'forward' | 'back' | 'left' | 'right' | 'drift';
type HeldControls = Readonly<Record<KartControl, boolean>>;
const CONTROLS: readonly KartControl[] = ['forward', 'back', 'left', 'right', 'drift'];
const RELEASED: HeldControls = { forward: false, back: false, left: false, right: false, drift: false };

/** Each finger owns its hold: letting one go never releases another finger on the same button. */
export function createKartTouchControls() {
  const pointers = new Map<number, KartControl>();
  const listeners = new Set<() => void>();
  let held = RELEASED;
  const publish = () => {
    const next = { ...RELEASED };
    for (const control of pointers.values()) next[control] = true;
    if (CONTROLS.every(control => next[control] === held[control])) return;
    held = next;
    for (const listener of listeners) listener();
  };
  return {
    press(control: KartControl, pointer: number) { pointers.set(pointer, control); publish(); },
    release(pointer: number) { if (pointers.delete(pointer)) publish(); },
    reset() { if (pointers.size) { pointers.clear(); publish(); } },
    getSnapshot: () => held,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export const kartTouchControls = createKartTouchControls();
export const useKartTouchControls = () => useSyncExternalStore(kartTouchControls.subscribe, kartTouchControls.getSnapshot, kartTouchControls.getSnapshot);

/** The driver reads this each frame. Touch and keyboard holds share the same directions, without doubling an axis. */
export function readKartInput(keys: ReadonlySet<string>): KartInput {
  const touch = kartTouchControls.getSnapshot();
  const held = (control: KartControl) => touch[control] || KART_KEYS[control].some(code => keys.has(code));
  return {
    throttle: Number(held('forward')) - Number(held('back')),
    steer: Number(held('right')) - Number(held('left')),
    drift: held('drift'),
  };
}
