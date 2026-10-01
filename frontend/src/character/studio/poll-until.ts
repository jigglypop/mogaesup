/** Resolves after `ms`, or at once when `signal` aborts. */
export const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Reads, `delayMs` apart, until `settled` accepts what was read: gives what it accepted, or nothing once `attempts` reads
 * were not enough. It stops as soon as `signal` aborts, with nothing more read. `settled` may throw to end the wait.
 */
export async function pollUntil<Read, Found>(
  read: (signal: AbortSignal) => Promise<Read>,
  settled: (value: Read) => Found | undefined,
  { attempts, delayMs, signal, immediate = false }: { attempts: number; delayMs: number; signal: AbortSignal; immediate?: boolean },
): Promise<Found | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0 || !immediate) await pause(delayMs, signal);
    if (signal.aborted) return undefined;
    const found = settled(await read(signal));
    if (found !== undefined) return found;
  }
  return undefined;
}
