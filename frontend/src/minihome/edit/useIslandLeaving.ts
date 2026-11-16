import { useCallback, useEffect, useRef, type RefObject } from 'react';

import { useNavigate } from 'react-router-dom';

import { onLeaving } from '../../shell/leaving';
import { useSaver } from './context';
import { appDestination, guardHistory, hasUnsaved, onIsland, waitsForOwner } from './leave';
import type { IslandSaver } from './save';

export const LEAVE_QUESTION = '저장하지 못한 변경이 있어요. 나가면 사라져요. 계속할까요?';

type Leaving = {
  saver: IslandSaver;
  /** Saves now (the 저장 button's save), answering whether it stored the island. */
  save: () => Promise<boolean>;
  /** The viewer owns the island; only an owner has edits to lose. */
  owner: boolean;
  /** The decorating screen is open. */
  decorating: boolean;
  /** The address is the decorating screen's (it changes as the page moves between the island and its editor). */
  editing: boolean;
  username: string;
  /**
   * Set when the owner chose to leave without edits that could not be saved; the island's unmount reads it (to drop
   * them rather than hold them) and staying on this island clears it.
   */
  discarding: RefObject<boolean>;
  /** The stored island was read again over the dropped edits. */
  onReloaded: () => void;
};

/**
 * How the owner leaves an island with edits on it. `leave(to)` saves first; with nothing unsaved (or nothing that can be
 * saved yet) it just goes. When the save fails the owner may stay with the edits or go without them. One leaving at a
 * time, and none once the island is gone (the save can answer after Back or a sign-out took the page elsewhere).
 *
 * The router here has no way to block a navigation, so a link out of the editor (the rail, the brand), or off an island
 * whose edits wait for its owner (`waitsForOwner`), is caught as it is clicked and goes the same way, as does a move
 * that is not a link (the search box, through `leaveFor`); Back and Forward off such an island, and closing the page,
 * ask first (`guardHistory`). Other edits are kept by the island's leaving, which saves them later.
 */
export function useIslandLeaving({ saver, save, owner, decorating, editing, username, discarding, onReloaded }: Leaving) {
  const navigate = useNavigate();
  const state = useSaver(saver);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const leaving = useRef(false);
  const leave = useCallback(
    (to: string) => {
      if (leaving.current) return;
      if (!hasUnsaved(saver.getState())) {
        navigate(to);
        return;
      }
      leaving.current = true;
      void save()
        .then((ok) => {
          if (!mounted.current) return;
          if (!ok && !window.confirm(LEAVE_QUESTION)) return;
          discarding.current = !ok;
          navigate(to);
        })
        .finally(() => {
          leaving.current = false;
        });
    },
    [saver, save, navigate, discarding],
  );

  const guarding = owner && waitsForOwner(state);
  // A link marked to keep the edits (signing in again, after which they are saved) is left alone, and so is one to this
  // same island outside the editor, which keeps the island (and its edits) mounted.
  useEffect(() => {
    if (!decorating && !guarding) return undefined;
    /** Whether a move to `to` leaves what holds these edits (any page but this island's own, from the editor). */
    const loses = (to: string) => hasUnsaved(saver.getState()) && (decorating || !onIsland(to, username));
    const intercept = (event: MouseEvent) => {
      const to = appDestination(event);
      if (to === null || !loses(to)) return;
      if (event.target instanceof Element && event.target.closest('[data-keep-edits]')) return;
      event.preventDefault();
      event.stopPropagation();
      leave(to);
    };
    document.addEventListener('click', intercept, true);
    const stopLeaving = onLeaving((to) => {
      if (!loses(to)) return false;
      leave(to);
      return true;
    });
    return () => {
      document.removeEventListener('click', intercept, true);
      stopLeaving();
    };
  }, [decorating, guarding, saver, leave, username]);

  // Set up again after each move between the island and its editor, which is where Back would return to.
  useEffect(() => {
    if (!guarding) return undefined;
    return guardHistory({
      stays: (path) => onIsland(path, username),
      ask: () => window.confirm(LEAVE_QUESTION),
      leaving: () => {
        discarding.current = true;
      },
    });
  }, [guarding, editing, username, discarding]);

  // Closing or reloading the page asks as well, outside the editor too: nothing would save these edits afterwards.
  useEffect(() => {
    if (!guarding) return undefined;
    const closing = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', closing);
    return () => window.removeEventListener('beforeunload', closing);
  }, [guarding]);

  // Finishing decorating saves what is left, rather than waiting for the autosave (unless the owner chose to leave it).
  // Decorating again starts with nothing chosen to be dropped: leaving keeps the new edits unless the owner chooses again.
  useEffect(() => {
    if (!decorating) return undefined;
    discarding.current = false;
    return () => {
      if (!discarding.current) void saver.flush();
    };
  }, [decorating, saver, discarding]);

  // Leaving the editor for this same island keeps the island mounted: the edits the owner chose to leave without are
  // dropped here, by reading the stored island again, and the next leaving starts afresh rather than discarding.
  const reloaded = useRef(onReloaded);
  reloaded.current = onReloaded;
  useEffect(() => {
    if (decorating || !discarding.current) return;
    discarding.current = false;
    void saver.reloadLatest().then((loaded) => {
      if (loaded && mounted.current) reloaded.current();
    });
  }, [decorating, saver, discarding]);

  return { leave, guarding };
}
