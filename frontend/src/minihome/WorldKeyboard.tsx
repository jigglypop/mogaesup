import { useEffect } from 'react';

import { useWorldLoadProgress } from 'gaesup-world';

const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'e', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
const nothingFocused = () => !document.activeElement || document.activeElement === document.body;
const worldCanvas = () => document.querySelector<HTMLCanvasElement>('.mg-world-canvas canvas');

/**
 * The world reads the keyboard only while its canvas has focus. It takes focus once the island is ready, and again when a
 * movement key is pressed with nothing focused, so WASD works without clicking the world first. Typing elsewhere is left alone.
 */
export function WorldKeyboard({ enabled }: { enabled: boolean }) {
  const { stage } = useWorldLoadProgress();
  const ready = stage === 'ready';
  useEffect(() => {
    if (!enabled || !ready) return undefined;
    if (nothingFocused()) worldCanvas()?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || !MOVE_KEYS.has(event.key.toLowerCase()) || !nothingFocused()) return;
      const canvas = worldCanvas();
      if (!canvas) return;
      canvas.focus({ preventScroll: true });
      // This keydown already left for the page; the world hears it again from its own canvas.
      event.stopImmediatePropagation();
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, code: event.code, repeat: event.repeat, shiftKey: event.shiftKey, bubbles: true, cancelable: true }));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled, ready]);
  return null;
}
