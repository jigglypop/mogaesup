import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]';

/** Whether the element is drawn: not under `display: none` or `visibility: hidden` (where the browser can tell). */
const shown = (element: HTMLElement) =>
  typeof element.checkVisibility !== 'function' || element.checkVisibility({ visibilityProperty: true });

/**
 * What Tab reaches inside `root`, in order: elements in the Tab order (not `tabindex="-1"`), and none that are hidden,
 * inert or not drawn.
 */
export const focusables = (root: ParentNode): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.tabIndex >= 0 && !element.closest('[hidden], [inert]') && shown(element),
  );

/**
 * Keeps the keyboard inside a modal dialog while it is open: focus moves into it (to `initial`, or its first control),
 * Tab and Shift+Tab wrap around inside it, and closing it hands focus back to whatever had it before.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, initial?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initial?.current ?? focusables(root)[0] ?? root).focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusables(root);
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      // On the dialog itself (where it rests while its controls are busy) or outside it, Tab goes in from either end.
      const off = at === root || !root.contains(at);
      if (!first || !last) {
        event.preventDefault();
        root.focus();
      } else if (event.shiftKey && (at === first || off)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (at === last || off)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trap, true);
    return () => {
      document.removeEventListener('keydown', trap, true);
      if (before?.isConnected) before.focus();
    };
  }, [ref, initial]);
}
