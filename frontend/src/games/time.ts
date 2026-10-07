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

/** How long a sample of the server's clock counts, how fast the estimate drifts toward a new one, and how far off it
 * must be to be taken at once. */
const CLOCK_WINDOW_MS = 10_000;
const CLOCK_SLEW = 0.05;
const CLOCK_SNAP_MS = 1_000;

export type ServerClock = {
  /** The server's time a frame carried, taken as it arrives. */
  sample: (server: number) => void;
  /** The server's clock now, in ms. */
  now: () => number;
};

/**
 * The server's clock as frames show it. A frame's time is older by however long it took to arrive, which jitters: the
 * estimate is the latest sample that came quickest (the largest offset of the last ten seconds), and it moves toward
 * a new one by at most 5 % of the time since the last, so a countdown or a bot's route does not jump with each frame.
 * One a second or more off is taken at once. The page's own time is `performance.now`, which never jumps: a computer
 * whose clock is set meanwhile does not carry the countdowns with it.
 */
export function createServerClock(local: () => number = () => performance.now()): ServerClock {
  let samples: { at: number; offset: number }[] = [];
  let offset: number | null = null;
  let movedAt = 0;
  return {
    sample(server) {
      const at = local();
      samples = [...samples.filter((sample) => at - sample.at < CLOCK_WINDOW_MS), { at, offset: server - at }];
      const best = Math.max(...samples.map((sample) => sample.offset));
      if (offset === null || Math.abs(best - offset) >= CLOCK_SNAP_MS) {
        offset = best;
      } else {
        const step = Math.max(1, (at - movedAt) * CLOCK_SLEW);
        offset += Math.max(-step, Math.min(step, best - offset));
      }
      movedAt = at;
    },
    now: () => local() + (offset ?? 0),
  };
}

/** `m:ss`, rounded up to the second, as a countdown reads. */
export const clock = (ms: number) => {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
