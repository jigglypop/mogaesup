import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Build } from './build';
import { DUSK, GOLDEN, type Mood } from './mood';

// What the pieces of a canvas share while it comes up: the hour it is seen at, and the count of what is still to be
// built, which the first frame waits for.


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
 * How many islands are still to be built: the canvas waits for them before it draws its first frame. `total` is how
 * many were asked for since the canvas last began making a village ready (see Stage's Meter). `warm` says it has
 * stopped waiting and is drawing, `shown` that it has drawn what it asked for and shows; `activeAt` is when the camera
 * last moved (performance.now()), `interval` how many milliseconds apart frames are meant to be drawn now.
 */
export type Works = { pending: number; total: number; warm: boolean; shown: boolean; activeAt: number; interval: number };

/** A canvas's works before anything is built. */
export const newWorks = (): Works => ({ pending: 0, total: 0, warm: false, shown: false, activeAt: 0, interval: 1000 / 60 });

/** Counts `count` more things to be built before the canvas shows. */
export function countWork(works: Works | null, count: number): void {
  if (!works) return;
  works.pending += count;
  works.total += count;
}
export const WorksContext = createContext<Works | null>(null);

/** A photo's shutter waits until every asynchronous decoration has committed its meshes to the scene. */
export const PhotoAssets = createContext<{ pending: number } | null>(null);
export function usePhotoAsset(ready: boolean): void {
  const photo = useContext(PhotoAssets);
  useLayoutEffect(() => {
    if (ready || !photo) return;
    photo.pending += 1;
    return () => { photo.pending -= 1; };
  }, [photo, ready]);
}

/**
 * What `make` builds (or will have, see kept), in a task of its own after mounting: a village is built an island at a
 * time (in `turn` order, as the islands were mounted), and the page can answer between one island and the next. The
 * islands are not held apart any longer than that: the canvas waits, out of sight, for every one of them. A new `make`
 * builds again; a new `turn` alone (the island has moved in the village) does not.
 */
export function useBuild(make: () => Build | Promise<Build>, turn: number): Build | null {
  const works = useContext(WorksContext);
  const [build, setBuild] = useState<Build | null>(null);
  const order = useRef(turn);
  order.current = turn;
  useEffect(() => {
    let counted = true;
    countWork(works, 1);
    const settle = () => {
      if (counted && works) works.pending -= 1;
      counted = false;
    };
    const timer = setTimeout(
      () => {
        // A build that cannot be made is reported, and the canvas does not wait for it forever.
        let made: Build | Promise<Build>;
        try {
          made = make();
        } catch (error) {
          reportError(error);
          settle();
          return;
        }
        if (!(made instanceof Promise)) {
          setBuild(made);
          settle();
          return;
        }
        // Kept from an earlier visit, or being read from it (see kept): once it is here, unless the island has gone.
        made.then(
          (build) => {
            if (counted) setBuild(build);
            settle();
          },
          (error: unknown) => {
            reportError(error);
            settle();
          },
        );
      },
      works?.warm ? 0 : order.current,
    );
    return () => {
      clearTimeout(timer);
      settle();
    };
  }, [make, works]);
  return build;
}
