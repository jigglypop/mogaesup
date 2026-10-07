import { useCallback, useEffect, useReducer } from 'react';
import { SavedRequestGone } from './api';

/**
 * Screens read their saved requests from storage as they render. This renders again when another tab changes storage
 * (it saved, answered or cleared one). The returned `gone(error)` is true when a recovery found its request no longer
 * saved, and renders again, so the screen shows what storage holds now instead of an error.
 */
export function useSavedRequests() {
  const [, render] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    window.addEventListener('storage', render);
    return () => window.removeEventListener('storage', render);
  }, []);
  return useCallback((error: unknown) => {
    if (!(error instanceof SavedRequestGone)) return false;
    render();
    return true;
  }, []);
}
