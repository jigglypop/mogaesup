import { useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = 'mogaesup.theme';
const listeners = new Set<(choice: ThemeChoice) => void>();
const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'dark' || value === 'system' ? value : 'light';
  } catch {
    return 'light';
  }
}

let current: ThemeChoice = stored();

function apply() {
  const dark = current === 'dark' || (current === 'system' && !!darkQuery?.matches);
  document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
}

/** Applies the saved theme before the first paint; light unless the viewer chose otherwise. */
export function initTheme() {
  apply();
  darkQuery?.addEventListener('change', () => current === 'system' && apply());
}

export function setTheme(choice: ThemeChoice) {
  current = choice;
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Private windows may refuse storage; the choice still holds for this page.
  }
  apply();
  for (const listener of listeners) listener(choice);
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState(current);
  useEffect(() => {
    listeners.add(setChoice);
    return () => {
      listeners.delete(setChoice);
    };
  }, []);
  return [choice, setTheme];
}
