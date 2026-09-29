import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';

// One bounded read at a time. A lost connection never clears the last good value.
// The interval may depend on the last value (for example slower once a job has settled);
// changing it takes effect on the next read without restarting the loop.
export function usePolling<T>(read: (signal: AbortSignal) => Promise<T>, interval: number | ((value: T | undefined) => number) = 3000) {
  const [value, update] = useState<T>();
  const [error, setError] = useState(''), [receivedAt, setReceivedAt] = useState<number>();
  const [loading, setLoading] = useState(true);
  const refreshRef = useRef<() => Promise<void>>(async () => {}), revision = useRef(0);
  const intervalRef = useRef(interval); intervalRef.current = interval;
  const latest = useRef<T | undefined>(undefined);
  const scheduleRef = useRef<() => void>(() => {});
  // A value saved from an action (for example a started stage) also reschedules the next read
  // with the interval that value implies.
  const setValue = useCallback((next: SetStateAction<T | undefined>) => {
    revision.current++;
    const value = typeof next === 'function' ? (next as (current: T | undefined) => T | undefined)(latest.current) : next;
    latest.current = value; update(value);
    scheduleRef.current();
  }, []);
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => { latest.current = value; }, [value]);
  useEffect(() => {
    let active = true, firstRead = true, failures = 0, again = false, controller: AbortController | undefined, timer: ReturnType<typeof setTimeout>;
    update(undefined); setError(''); setReceivedAt(undefined); setLoading(true); latest.current = undefined;
    const delay = () => {
      const current = intervalRef.current;
      return typeof current === 'function' ? current(latest.current) : current;
    };
    const poll = async () => {
      // A refresh during a read runs once more after it, so a just-saved change is not missed.
      if (controller) { again = true; return; }
      // Populate a newly opened tab once; pause its repeated reads while hidden.
      if (!active || (document.hidden && !firstRead)) return;
      firstRead = false;
      clearTimeout(timer);
      controller = new AbortController(); const started = revision.current;
      try {
        const result = await read(controller.signal);
        if (active && started === revision.current) { latest.current = result; update(result); setError(''); setReceivedAt(Date.now()); }
        failures = 0;
      } catch (e) { if (active) { failures++; setError((e as Error).message); } }
      finally {
        controller = undefined;
        if (active) {
          setLoading(false);
          const base = delay();
          timer = setTimeout(() => void poll(), again ? 0 : Math.min(base * 2 ** failures, Math.max(base, 15000)));
          again = false;
        }
      }
    };
    const reconnect = () => { if (!document.hidden) void poll(); };
    scheduleRef.current = () => {
      if (!active || controller) return;
      clearTimeout(timer); timer = setTimeout(() => void poll(), delay());
    };
    refreshRef.current = poll; void poll();
    window.addEventListener('online', reconnect); document.addEventListener('visibilitychange', reconnect);
    return () => {
      active = false; clearTimeout(timer); controller?.abort(); scheduleRef.current = () => {};
      window.removeEventListener('online', reconnect); document.removeEventListener('visibilitychange', reconnect);
    };
  }, [read]);
  return { value, setValue, error, receivedAt, loading, refresh };
}
