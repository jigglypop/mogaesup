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

/** Resolves when the saver has no save in flight (at once if it has none). */
const idle = (saver: IslandSaver) =>
  saver.getState().saving
    ? new Promise<void>((done) => {
        const stop = saver.subscribe(() => {
          if (saver.getState().saving) return;
          stop();
          done();
        });
      })
    : Promise.resolve();

/**
 * Edits nothing will save until the owner acts: a conflict waits for their choice, a too large or refused island for a
 * change. Leaving the island drops them, so leaving asks first (`guardHistory` for Back and Forward).
 */
export const waitsForOwner = (state: SaverState) => hasUnsaved(state) && finished(state);

type HistoryEntry = { state: unknown; href: string };
const indexOf = (state: unknown) => {
  const index = (state as { idx?: unknown } | null)?.idx;
  return typeof index === 'number' ? index : null;
};

/**
 * While edits wait for their owner (`waitsForOwner`), Back and Forward to a page off the island ask first. It listens
 * ahead of the router (capturing, on the window); declining stops the router from hearing the move and goes back to
 * where the page was (by the router's own history index, or else by putting the address back). `stays` says which paths
 * keep the island open (its own and its decorating screen); `leaving` runs when the owner chose to go.
 */
export function guardHistory(
  { stays, ask, leaving }: { stays: (path: string) => boolean; ask: () => boolean; leaving: () => void },
  win: Window = window,
): () => void {
  let here: HistoryEntry = { state: win.history.state, href: win.location.href };
  const popped = (event: PopStateEvent) => {
    if (stays(win.location.pathname)) {
      here = { state: win.history.state, href: win.location.href };
      return;
    }
    if (ask()) {
      leaving();
      return;
    }
    event.stopImmediatePropagation();
    const from = indexOf(here.state);
    const to = indexOf(event.state);
    if (from !== null && to !== null && from !== to) win.history.go(from - to);
    else win.history.pushState(here.state, '', here.href);
  };
  win.addEventListener('popstate', popped, true);
  return () => win.removeEventListener('popstate', popped, true);
}

/** Edits a held saver could still store without its owner: not done, and not waiting for them to sign in again. */
const stillSaving = (state: SaverState) => !finished(state) && state.problem?.kind !== 'session';

/** A held island under the key opened again could not be saved yet; opening it now would read the copy before it. */
export class HeldSaveError extends Error {
  constructor() {
    super('저장하지 못한 섬이 있어요.');
    this.name = 'HeldSaveError';
  }
}

/**
 * Resolves once no island left under `key` has a save on its way, so opening the same island again reads what that
 * save stored rather than the copy before it (signing in again resumes a held save just before the island reopens). A
 * save in flight is waited for; one waiting out its retry delay is sent now. When that fails again it rejects with
 * `HeldSaveError`, and the island waits (its start fails, with a retry) instead of opening over edits still on their way.
 */
export async function heldSavesSettled(key: string): Promise<void> {
  const held = [...holding].filter(([, of]) => of === key).map(([saver]) => saver);
  await Promise.all(
    held.map(async (saver) => {
      await idle(saver);
      if (saver.disposed || !stillSaving(saver.getState())) return;
      await saver.flush();
      await idle(saver);
      if (!saver.disposed && stillSaving(saver.getState())) throw new HeldSaveError();
    }),
  );
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

/** Whether `path` opens the island of `username` or its decorating screen: moving there keeps the island mounted. */
export function onIsland(path: string, username: string): boolean {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed escape is read as it is.
  }
  const [slug, rest, ...more] = (decoded.split(/[?#]/)[0] ?? '').split('/').filter(Boolean);
  return more.length === 0 && (rest === undefined || rest === 'edit') && slug?.toLowerCase() === `@${username.toLowerCase()}`;
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
