import { useSyncExternalStore } from 'react';

import { ApiRequestError, api } from './client';

/**
 * The character studio's instance powers itself off when idle; the server starts it on the next studio request and
 * answers `studio_waking` (or `studio_stopping` while it is still shutting down) until it is up.
 */
export type StudioSleepCode = 'studio_waking' | 'studio_stopping';
export type StudioSleep = { code: StudioSleepCode; message: string; since: number };

/** How often a screen waiting for the studio asks again. */
export const WAKE_RETRY_MS = 10_000;

export const isStudioAsleep = (code: unknown): code is StudioSleepCode =>
  code === 'studio_waking' || code === 'studio_stopping';

let current: StudioSleep | null = null;
const listeners = new Set<() => void>();

/** Records what a studio request was answered: a sleep `code`, or anything else (the studio is up). */
export function reportStudio(code?: unknown, message?: string) {
  const next = isStudioAsleep(code) ? { code, message: message ?? '', since: current?.since ?? Date.now() } : null;
  if (next?.code === current?.code && next?.message === current?.message) return;
  current = next;
  for (const listener of listeners) listener();
}

/** The studio's sleep as the last studio request found it, or null while it answers. */
export const currentStudioSleep = (): StudioSleep | null => current;

export function useStudioSleep(): StudioSleep | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentStudioSleep,
    () => null,
  );
}

/** One light studio read any signed-in member may make; its answer updates the sleep state. */
export function probeStudio(): Promise<void> {
  return api('/avatar-factory/wardrobe/bodies').then(
    () => reportStudio(),
    (problem: unknown) => {
      if (problem instanceof ApiRequestError) reportStudio(problem.code, problem.message);
    },
  );
}
