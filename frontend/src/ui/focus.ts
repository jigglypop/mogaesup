import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** What Tab reaches inside `root`, in order; nothing under a `hidden` element. */
export const focusables = (root: ParentNode): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.closest('[hidden]'));

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
      if (!first || !last) {
        event.preventDefault();
        root.focus();
      } else if (event.shiftKey && (at === first || !root.contains(at))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (at === last || !root.contains(at))) {
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
