/** Work kept after navigation still belongs to the session that started it. */
let owner: string | null | undefined;
/** Set while the server refuses the session cookie of `owner`: their work waits for them to sign in again. */
let lapsed = false;
/** Counts owner changes and new cookies, so a refusal of a request sent before one is not taken for the new session's. */
let epoch = 0;
/** Requests of this page under way that start its session over (see `startOver`). */
let startingOver = 0;
const work = new Map<() => void, { expected: string; resume?: (() => void) | undefined }>();
const lapseListeners = new Set<() => void>();
const renewListeners = new Set<() => void>();

/**
 * Who the session belongs to now. Work started by someone else stops; work of this owner that waited through a lapsed
 * session (see `expireSession`) resumes.
 */
export function setSessionOwner(next: string | null): void {
  const back = lapsed;
  lapsed = false;
  owner = next;
  epoch++;
  for (const [stop, { expected, resume }] of [...work]) {
    if (expected === next) {
      if (back) resume?.();
      continue;
    }
    work.delete(stop);
    stop();
  }
}

export const sessionBelongsTo = (expected: string) => owner === expected;
/** Whether the signed-in member's session ran out and nobody has signed in or out since. */
export const sessionLapsed = () => lapsed;
/** Taken when a request is sent; `expireSession` compares it, so a late refusal of an earlier session changes nothing. */
export const sessionEpoch = () => epoch;

/**
 * `stop` runs when the session passes to anyone but `expected` (or nobody signs in as them at all: a sign-out);
 * `resume` runs when `expected` signs in again after their session lapsed, and when their session goes on under a new
 * cookie (`startOver`), which a request sent with the old one may have been refused for.
 */
export function followSessionOwner(expected: string, stop: () => void, resume?: () => void): () => void {
  if (owner !== undefined && owner !== expected) {
    stop();
    return () => {};
  }
  work.set(stop, { expected, resume });
  return () => { work.delete(stop); };
}

/**
 * The server refused the session cookie (a 401) on a request sent at `sentAt`: the member is signed out, but what they
 * were doing keeps its owner, so signing in again as them carries on with it. Nothing changes when nobody was signed
 * in, the session changed since the request went out, or this page is starting its session over (`startOver`).
 */
export function expireSession(sentAt: number = epoch): void {
  if (!owner || lapsed || startingOver > 0 || sentAt !== epoch) return;
  lapsed = true;
  for (const listener of [...lapseListeners]) listener();
}

/**
 * The session goes on under a new cookie: a refusal of a request sent before counts for nothing from now on, and the
 * owner's work that such a refusal held up goes on (`resume`).
 */
function renew(): void {
  epoch++;
  if (lapsed) return;
  for (const { expected, resume } of [...work.values()]) {
    if (expected === owner) resume?.();
  }
}

/**
 * Marks a request that starts this browser's session over (a password change, signing out the other devices) until
 * the returned end is called. The server ends the old session, and closes the realtime sockets on it (they connect
 * again), before its answer brings the new cookie: until that answer is in, a refusal of the old cookie is not the
 * member signing out. `end('renewed')`: the answer brought the new cookie, so requests sent before it count from a new
 * epoch, the work they held up goes on, and `onSessionRenewed` hears it (the other tabs are told). `end('refused')`: the
 * request itself was refused for its session, which had ended before it, so no new cookie comes and the session lapses.
 * `end()`: it failed otherwise (a wrong password, no answer).
 */
export function startOver(): (outcome?: 'renewed' | 'refused') => void {
  const sentAt = epoch;
  startingOver++;
  let ended = false;
  return (outcome) => {
    if (ended) return;
    ended = true;
    startingOver--;
    if (outcome === 'refused') expireSession(sentAt);
    else if (outcome === 'renewed') {
      renew();
      for (const listener of [...renewListeners]) listener();
    } else epoch++;
  };
}

/** Calls `listener` when this page's `startOver` brought the session a new cookie; returns the stop for it. */
export function onSessionRenewed(listener: () => void): () => void {
  renewListeners.add(listener);
  return () => { renewListeners.delete(listener); };
}

/** Another tab started the session over: this page sends the new cookie from now on (see `startOver`). */
export const renewedElsewhere = (): void => renew();

/**
 * Whether the server refusing the session cookie of a request sent at `sentAt` speaks of a cookie this page has replaced
 * since (a sign-in, a session started over), or is replacing now: not of the session it goes on with.
 */
export const cookieReplaced = (sentAt: number): boolean => startingOver > 0 || sentAt !== epoch;

/** Calls `listener` when the session lapses; returns the stop for it. */
export function onSessionLapse(listener: () => void): () => void {
  lapseListeners.add(listener);
  return () => { lapseListeners.delete(listener); };
}

const checkListeners = new Set<() => void>();

/**
 * Something answered for another member than the one signed in here (a realtime ticket issued to someone else): the
 * session cookie changed hands, in another tab most likely. Who is signed in is asked again now.
 */
export function requestSessionCheck(): void {
  for (const listener of [...checkListeners]) listener();
}

/** Calls `listener` on `requestSessionCheck`; returns the stop for it. */
export function onSessionCheck(listener: () => void): () => void {
  checkListeners.add(listener);
  return () => { checkListeners.delete(listener); };
}

const unsavedChecks = new Set<() => boolean>();

/**
 * Registers a check for edits of the session's owner that are not saved yet (an island being decorated, or one left
 * while its save kept failing); signing out asks before dropping them. Returns the stop for it.
 */
export function trackUnsaved(check: () => boolean): () => void {
  unsavedChecks.add(check);
  return () => { unsavedChecks.delete(check); };
}

/** Whether signing out now would drop edits nobody saved. */
export const hasUnsavedWork = () => [...unsavedChecks].some((check) => check());
