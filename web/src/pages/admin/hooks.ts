import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { problemText } from '../../api/client';
import { catalogApi } from '../../api/endpoints';
import type { CatalogImport, FactoryImport } from '../../api/types';
import { finishedSince, isActive } from './catalogView';

/** How often running imports are asked about. */
const POLL_MS = 1500;

/**
 * The recent imports, polled while any is queued or running. `onFinished` hears about every import that ends while
 * the page watches, so the page can reload what it changed. Several imports can run at once; nothing here blocks.
 */
export function useImportQueue(enabled: boolean, onFinished: (ended: CatalogImport[]) => void) {
  const [imports, setImports] = useState<CatalogImport[] | null>(null);
  const [problem, setProblem] = useState('');
  const latest = useRef<CatalogImport[]>([]);
  /** Imports queued from this page that no listing has shown yet. */
  const started = useRef(new Set<string>());
  const notify = useRef(onFinished);
  useEffect(() => {
    notify.current = onFinished;
  });

  const apply = useCallback((incoming: CatalogImport[]) => {
    const listed = new Set(incoming.map((item) => item.id));
    // A listing asked for just before a POST can miss the new import; keep it until a listing has it.
    const pending = latest.current.filter((item) => started.current.has(item.id) && !listed.has(item.id));
    for (const id of listed) started.current.delete(id);
    const next = [...pending, ...incoming];
    const ended = finishedSince(latest.current, next);
    latest.current = next;
    setImports(next);
    if (ended.length) notify.current(ended);
  }, []);

  const refresh = useCallback(
    () =>
      catalogApi.imports().then(
        (result) => {
          setProblem('');
          apply(result.imports);
        },
        (error: unknown) => setProblem(problemText(error)),
      ),
    [apply],
  );

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const active = imports?.some(isActive) ?? false;
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer = 0;
    // One request at a time: the next poll waits for the last answer.
    const tick = async () => {
      await refresh();
      if (!stopped) timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [active, refresh]);

  /** Queues an import; it shows at the top at once and polling starts. */
  const start = useCallback(async (body: FactoryImport) => {
    const queued = await catalogApi.importFactory(body);
    started.current.add(queued.id);
    const next = [queued, ...latest.current.filter((item) => item.id !== queued.id)];
    latest.current = next;
    setImports(next);
    return queued;
  }, []);

  return { imports, problem, refresh, start };
}

/** Whether a media query matches now, following changes (e.g. a phone turned sideways). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (changed: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', changed);
      return () => list.removeEventListener('change', changed);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}

/** Phones and narrow windows get the card layouts. */
export const NARROW = '(max-width: 720px)';
