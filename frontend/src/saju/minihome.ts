import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiRequestError } from '../api/client';
import { homeApi, sajuApi } from '../api/endpoints';
import type { HomeView, HomeVisibility, ProfileChanges, VisitCounter } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { visitorId } from '../minihome/stored';
import { REQUESTS_CHANGED } from '../shell/Shell';
import { ask, pageArrived, takeEarly } from './early';
import { isValidBirthDate, type Birth } from './engine';
import { NAME_MAX, residentOf, type Resident } from './residents';

/** A member's 섬 as the server gave it to this viewer. */
export type Minihome = {
  view: HomeView;
  /** The owner's 사주 home, once they have built one. */
  owner: Resident | null;
  /**
   * The homes around the owner's: their 이웃' (`neighbour`, joined to it by a bridge) and other members'. A home this
   * viewer may not go into stands among them closed (`visitable` false).
   */
  village: (Resident & { neighbour: boolean; visitable: boolean })[];
  /** The viewer's own home: the owner's on their own 섬, null for a visitor without one. */
  mine: Resident | null;
  /** Who it was read for: the signed-in viewer's username, null for a signed-out visit. */
  as: string | null;
};

export type MinihomeState =
  | { status: 'loading' }
  /** `code` is the HTTP status (404 no such member, 403 a home kept from this viewer), 0 when no answer came. */
  | { status: 'failed'; code: number; message: string }
  | { status: 'ready'; minihome: Minihome };

pageArrived();

/**
 * Makes `change` to the page's 섬 if it is still the one an owner's change was made on: `ownerId`'s, read for its
 * owner. An answer that comes back after the page has gone on to another 섬 (or after someone else has signed in) is
 * not that 섬's.
 */
const onOwn = (ownerId: string, change: (minihome: Minihome) => Minihome) => (current: MinihomeState): MinihomeState =>
  current.status === 'ready' && current.minihome.view.isOwner && current.minihome.view.profile.ownerId === ownerId
    ? { status: 'ready', minihome: change(current.minihome) }
    : current;

async function read(username: string, viewer: string | null): Promise<Minihome> {
  // One round trip: the visitor's own home does not wait for this one to arrive. The route may have asked already,
  // while this page's code was arriving (see early).
  const answers = takeEarly(username, viewer) ?? ask(username, viewer);
  const [view, village, mine] = await Promise.all([answers.view, answers.village, answers.mine]);
  const owner = village.saju && residentOf(username, village.saju);
  return {
    view,
    owner,
    village: village.village.map(({ user, saju, neighbour, visitable }) => ({ ...residentOf(user.username, saju), neighbour, visitable: visitable !== false })),
    mine: viewer === username ? owner : mine && viewer ? residentOf(viewer, mine) : null,
    as: viewer,
  };
}

/**
 * `username`'s 섬 for whoever is signed in, counted as a visit once. It is read again, without leaving the page,
 * when an 이웃 request is answered here or from the bell: 이웃 come first in a village. `build`, `demolish` and `open`
 * (who may see the home) are the owner's: they keep the change on the server and show the answer.
 */
export function useMinihome(username: string) {
  const { status, user, lapsed, nameAs } = useAuth();
  const viewer = user?.username ?? null;
  const settled = status !== 'loading';
  const [state, setState] = useState<MinihomeState>({ status: 'loading' });
  // Only a different person reads the 섬 again, not a new user object for the same one. When the session of the
  // member it was read for lapses, the page stays with what they were writing (signing in again as them keeps it as it
  // is); someone else signing in, or a sign-out, reads it afresh.
  const readFor = state.status === 'ready' ? state.minihome.as : null;
  const viewerKey = !user && lapsed && readFor === lapsed.username ? lapsed.username : viewer;

  // What the owner has changed here (a home built or taken down, a door opened or closed), counted: a read that began
  // before the latest of them may hold the answer from before it.
  const writes = useRef(0);

  useEffect(() => {
    if (!settled) return undefined;
    let live = true;
    let reads = 0;
    let visits: VisitCounter | null = null;
    setState({ status: 'loading' });
    // The page does not wait for its visit to be counted: the count joins it whenever it comes.
    void homeApi.visit(username, visitorId()).then(
      (counted) => {
        if (!counted || !live) return;
        visits = counted;
        setState((current) => (current.status === 'ready' ? { status: 'ready', minihome: { ...current.minihome, view: { ...current.minihome.view, visits: counted } } } : current));
      },
      () => undefined,
    );
    /** Reads the 섬 and shows the answer, unless a newer read has started; `refused` hears what it could not read. */
    const load = (refused: (error: unknown) => void) => {
      const mine = ++reads;
      const began = writes.current;
      read(username, viewer).then(
        (minihome) => {
          if (!live || mine !== reads) return;
          // The owner changed something while this was on its way: it is read once more rather than shown.
          if (began !== writes.current) return load(refused);
          setState({ status: 'ready', minihome: { ...minihome, view: { ...minihome.view, visits: visits ?? minihome.view.visits } } });
        },
        (error: unknown) => {
          if (live && mine === reads) refused(error);
        },
      );
    };
    load((error) =>
      setState(
        error instanceof ApiRequestError
          ? { status: 'failed', code: error.status, message: error.message }
          : { status: 'failed', code: 0, message: '섬을 불러오지 못했어요' },
      ),
    );
    // What was on the page stays while the new village is on its way, and when no answer comes. A refusal (the home
    // is closed to this viewer now, as after ending 이웃 with the owner of a home kept to 이웃, or gone) is shown as one.
    const again = () =>
      load((error) => {
        if (error instanceof ApiRequestError && (error.status === 403 || error.status === 404)) {
          setState({ status: 'failed', code: error.status, message: error.message });
        }
      });
    window.addEventListener(REQUESTS_CHANGED, again);
    return () => {
      live = false;
      window.removeEventListener(REQUESTS_CHANGED, again);
    };
  }, [username, viewerKey, settled]);

  const ownerId = state.status === 'ready' && state.minihome.view.isOwner ? state.minihome.view.profile.ownerId : null;
  const build = useCallback(
    async (name: string, birth: Birth) => {
      if (!ownerId) return;
      const { saju } = await sajuApi.save({ expectedOwnerId: ownerId, name, birth });
      const built = residentOf(username, saju);
      writes.current += 1;
      setState(onOwn(ownerId, (minihome) => ({ ...minihome, owner: built, mine: built })));
    },
    [ownerId, username],
  );
  const demolish = useCallback(async () => {
    if (!ownerId) return;
    await sajuApi.remove({ expectedOwnerId: ownerId });
    writes.current += 1;
    setState(onOwn(ownerId, (minihome) => ({ ...minihome, owner: null, mine: null })));
  }, [ownerId]);
  const open = useCallback(
    async (visibility: HomeVisibility, consent = false) => {
      if (!ownerId) return;
      const { profile } = await homeApi.update({
        expectedOwnerId: ownerId,
        visibility,
        ...(consent ? { sajuShareConsent: true } : {}),
      });
      writes.current += 1;
      setState(onOwn(ownerId, (minihome) => ({ ...minihome, view: { ...minihome.view, profile } })));
    },
    [ownerId],
  );
  const saveProfile = useCallback(
    async (changes: ProfileChanges) => {
      if (!ownerId) return;
      const { profile } = await homeApi.update({ expectedOwnerId: ownerId, ...changes });
      writes.current += 1;
      setState(onOwn(ownerId, (minihome) => ({ ...minihome, view: { ...minihome.view, profile } })));
      if (changes.displayName) nameAs(changes.displayName);
    },
    [ownerId, nameAs],
  );
  return { state, build, demolish, open, saveProfile };
}

// The village's first days kept each home in its browser's storage. A member who built one there finds its name and
// birth filled in when they build their home on the server, and the stored copy goes once that home is built.

const LEGACY_KEY = 'saju:village';
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The name and birth `raw` (a browser-kept village) holds for its own home, or null: storage is the viewer's to edit. */
export function legacyHomeOf(raw: string | null): { name: string; birth: Birth } | null {
  if (!raw) return null;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  const me = isRecord(stored) ? stored['me'] : null;
  if (!isRecord(me) || !isRecord(me['birth']) || typeof me['name'] !== 'string') return null;
  const { calendar, year, month, day, leapMonth, time, gender } = me['birth'];
  if (calendar !== 'solar' && calendar !== 'lunar') return null;
  if (gender !== 'female' && gender !== 'male') return null;
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number' || typeof leapMonth !== 'boolean') return null;
  if (time !== null && (typeof time !== 'string' || !TIME.test(time))) return null;
  const birth: Birth = { calendar, year, month, day, leapMonth: calendar === 'lunar' && leapMonth, time, gender };
  const name = [...me['name'].trim()].slice(0, NAME_MAX).join('');
  return name && isValidBirthDate(birth) ? { name, birth } : null;
}

export function readLegacyHome(): { name: string; birth: Birth } | null {
  try {
    return legacyHomeOf(localStorage.getItem(LEGACY_KEY));
  } catch {
    return null;
  }
}

export function forgetLegacyHome(): void {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // A private window may refuse storage; there is nothing kept to forget then.
  }
}
