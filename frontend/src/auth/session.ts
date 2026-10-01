import { ApiRequestError } from '../api/client';
import type { User } from '../api/types';

/** How long to wait before asking again, one per failed ask in a row; the last one repeats. */
export const SESSION_RETRY_MS = [1_000, 3_000, 10_000, 30_000] as const;

/**
 * Asks who the session cookie belongs to until the server answers. Only the server saying nobody (no user, or a 401)
 * makes anyone signed out: a failed ask (the line dropped, a 5xx, no answer in time) says nothing about the session, so it
 * is asked again, later each time, and nobody is taken for signed out meanwhile. Returns the stop for it.
 */
export function followSession(
  ask: () => Promise<{ user: User | null }>,
  answer: (user: User | null) => void,
  retryMs: readonly number[] = SESSION_RETRY_MS,
): () => void {
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    ask().then(
      (result) => {
        if (!stopped) answer(result.user);
      },
      (error: unknown) => {
        if (stopped) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          answer(null);
          return;
        }
        timer = setTimeout(run, retryMs[Math.min(failures, retryMs.length - 1)] ?? 30_000);
        failures++;
      },
    );
  };
  run();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
