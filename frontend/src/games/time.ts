import { useEffect, useState } from 'react';

/** Milliseconds left until `at` on the server's clock, kept current a few times a second; 0 once it has passed. */
export function useRemaining(at: number, serverNow: () => number, every = 250): number {
  const left = () => Math.max(0, at - serverNow());
  const [remaining, setRemaining] = useState(left);
  useEffect(() => {
    const tick = () => setRemaining(Math.max(0, at - serverNow()));
    tick();
    const timer = setInterval(tick, every);
    return () => clearInterval(timer);
  }, [at, serverNow, every]);
  return remaining;
}

/** `m:ss`, rounded up to the second, as a countdown reads. */
export const clock = (ms: number) => {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
