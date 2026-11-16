import { useEffect, useReducer } from 'react';

/**
 * Screens read their saved requests from storage as they render. This renders again when another tab changes storage
 * (it saved, answered or cleared one), so the screen shows what storage holds now.
 */
export function useSavedRequests() {
  const [, render] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    window.addEventListener('storage', render);
    return () => window.removeEventListener('storage', render);
  }, []);
}
