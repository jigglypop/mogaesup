import { savesLater, type IslandSaver, type SaverState } from './save';

/** What leaving the island could lose: edits not saved yet, or a save that has not answered. */
export const hasUnsaved = (state: SaverState) => state.phase === 'ready' && (state.dirty || state.saving);

/**
 * Whether a saver has nothing more to do for what it holds: it is all saved, or nothing will save it. A failed save the
 * line or the server caused is retried by the saver itself, and one refused for a lapsed session is saved once its
 * owner signs in again; one that waits for the owner's choice (a conflict) or for a change to the island (too large,
 * refused) is not.
 */
function finished(state: SaverState): boolean {
  if (state.saving) return false;
  if (!hasUnsaved(state)) return true;
  return state.conflict || (state.problem !== null && !savesLater(state.problem));
}

/**
 * Islands that were left with edits that could not be saved yet (each under the key it was left with), and the question
 * closing the page asks for them.
 */
const holding = new Map<IslandSaver, string | undefined>();
const closing = (event: BeforeUnloadEvent) => {
  for (const saver of holding.keys()) void saver.flush();
  event.preventDefault();
};
const askBeforeClosing = () => {
  if (holding.size) window.addEventListener('beforeunload', closing);
  else window.removeEventListener('beforeunload', closing);
};

/**
 * Resolves once no island left under `key` has a save on its way, so opening the same island again reads what that
 * save stored rather than the copy before it (signing in again resumes a held save just before the island reopens).
 */
export function heldSavesSettled(key: string): Promise<void> {
  const busy = [...holding].filter(([saver, of]) => of === key && saver.getState().saving).map(([saver]) => saver);
  return Promise.all(
    busy.map(
      (saver) =>
        new Promise<void>((done) => {
          const stop = saver.subscribe(() => {
            if (saver.getState().saving) return;
            stop();
            done();
          });
        }),
    ),
  ).then(() => undefined);
}

/**
 * Lets go of an island that is being left, once nothing is left to lose. What could not be saved yet is not dropped: its
 * saver keeps retrying in the background (or waits for its owner to sign in again) and `release` runs when it is saved,
 * or when nothing could save it. Until then closing the page asks first. `discard` is the owner's choice to leave
 * without the edits: it releases at once. `key` names the island for `heldSavesSettled`.
 */
export function leaveIsland(saver: IslandSaver, release: () => void, discard = false, key?: string): void {
  let stopWatching: (() => void) | undefined;
  let released = false;
  const letGo = () => {
    if (released) return;
    released = true;
    stopWatching?.();
    holding.delete(saver);
    askBeforeClosing();
    saver.dispose();
    release();
  };
  if (discard) {
    letGo();
    return;
  }
  void saver.flush().then(() => {
    if (saver.disposed || finished(saver.getState())) return letGo();
    holding.set(saver, key);
    askBeforeClosing();
    stopWatching = saver.subscribe(() => {
      if (saver.disposed || finished(saver.getState())) letGo();
    });
  });
}

type LinkClick = Pick<MouseEvent, 'target' | 'button' | 'defaultPrevented' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;
type Here = Pick<Location, 'href' | 'origin' | 'pathname' | 'search'>;

/**
 * Where a plain click on a link would take the app (its path, query and hash on this site), or null when the click does
 * something else: opens another tab or site, stays on this page, or is not an ordinary click.
 */
export function appDestination(event: LinkClick, here: Here = location): string | null {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
  if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return null;
  const url = new URL(anchor.getAttribute('href') ?? '', here.href);
  if (url.origin !== here.origin) return null;
  if (url.pathname === here.pathname && url.search === here.search) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
