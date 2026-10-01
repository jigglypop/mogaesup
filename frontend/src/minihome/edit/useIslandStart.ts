import { useEffect, useState } from 'react';

import type { IslandSaver } from './save';

type Starting = {
  runtime: { setup(): Promise<void> };
  saver: Pick<IslandSaver, 'load'>;
  history: { start(): void };
};

/**
 * Sets the island's engine up, loads the stored island into it and starts undo from there (never from the village the
 * engine begins with). When the engine will not start there is nothing to load: `failed` says so, and `retry` tries again.
 */
export function useIslandStart({ runtime, saver, history }: Starting) {
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    runtime
      .setup()
      .then(() => (alive ? saver.load() : false))
      .then((loaded) => {
        if (loaded && alive) history.start();
      })
      .catch((error: unknown) => {
        console.error(error);
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [runtime, saver, history, tries]);
  return { failed, retry: () => setTries((count) => count + 1) };
}
