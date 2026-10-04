import { useEffect } from 'react';

/** How long the server holds one player between kicks (ms). */
export const KICK_COOLDOWN = 400;

/** When each game client (by its `act`) last sent a kick, on this page's clock. */
const sent = new WeakMap<object, number>();

/** Sends `{"kick": true}` unless this page sent one less than the cooldown ago (the server would refuse it). */
export function kick(act: (action: unknown) => boolean, now = performance.now()): boolean {
  if (now - (sent.get(act) ?? -Infinity) < KICK_COOLDOWN) return false;
  if (!act({ kick: true })) return false;
  sent.set(act, now);
  return true;
}

/** Where keys are typed words, not kicks. */
const typing = (target: EventTarget | null) =>
  target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;

/**
 * While `enabled`, the F key kicks (by its place on the keyboard, whatever the layout or input method). It only listens
 * beside the world's own keys: movement goes on as before, and an F something else took first (the engine riding, the
 * island editor focusing on a piece) does not kick.
 */
export function useKickKey(enabled: boolean, act: (action: unknown) => boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'KeyF' || event.repeat || event.defaultPrevented || event.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
      kick(act);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, act]);
}
