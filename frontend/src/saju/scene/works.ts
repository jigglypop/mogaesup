import { createContext, useContext, useEffect, useState } from 'react';

import type { Build } from './build';
import { DUSK, GOLDEN, type Mood } from './mood';

// What the pieces of a canvas share while it comes up: the hour it is seen at, and the count of what is still to be
// built, which the first frame waits for.

/** Milliseconds between one island's building and the next. */
const BUILD_EVERY_MS = 60;

/** The hour the village is seen at: sunset under the light theme, dusk under the dark one. */
export function useMood(): Mood {
  const read = () => (typeof document !== 'undefined' && document.documentElement.dataset['theme'] === 'dark' ? DUSK : GOLDEN);
  const [mood, setMood] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setMood(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return mood;
}

/**
 * How many islands are still to be built: the canvas waits for them before it draws its first frame. `warm` says it
 * has stopped waiting and is drawing.
 */
export type Works = { pending: number; warm: boolean };
export const WorksContext = createContext<Works | null>(null);

/**
 * What `make` builds, a little after mounting and `turn` builds after the first: a village is built an island at a
 * time, between which the page can answer, instead of all at once. An island that joins a canvas already drawing (the
 * flag's, raised once the 이웃 are counted) has no turn to wait for: the others were built long before.
 */
export function useBuild(make: () => Build, turn: number): Build | null {
  const works = useContext(WorksContext);
  const [build, setBuild] = useState<Build | null>(null);
  useEffect(() => {
    let counted = true;
    if (works) works.pending += 1;
    const settle = () => {
      if (counted && works) works.pending -= 1;
      counted = false;
    };
    const timer = setTimeout(
      () => {
        setBuild(make());
        settle();
      },
      works?.warm ? 0 : turn * BUILD_EVERY_MS,
    );
    return () => {
      clearTimeout(timer);
      settle();
    };
  }, [make, turn, works]);
  return build;
}
