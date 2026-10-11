/** Work kept after navigation still belongs to the session that started it. */
let owner: string | null | undefined;
/** Set while the server refuses the session cookie of `owner`: their work waits for them to sign in again. */
let lapsed = false;
/** Counts owner changes, so a refusal of a request sent before one is not taken for the new session's. */
let epoch = 0;
const work = new Map<() => void, { expected: string; resume?: (() => void) | undefined }>();
const lapseListeners = new Set<() => void>();

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
 * `resume` runs when `expected` signs in again after their session lapsed.
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
 * in or the session changed since the request went out.
 */
export function expireSession(sentAt: number = epoch): void {
  if (!owner || lapsed || sentAt !== epoch) return;
  lapsed = true;
  for (const listener of [...lapseListeners]) listener();
}

/** Calls `listener` when the session lapses; returns the stop for it. */
export function onSessionLapse(listener: () => void): () => void {
  lapseListeners.add(listener);
  return () => { lapseListeners.delete(listener); };
}

const doubtListeners = new Set<() => void>();

/**
 * The server answered a request for someone other than the member signed in here (another tab signed in as them): who
 * the session belongs to is asked again.
 */
export function doubtSession(): void {
  for (const listener of [...doubtListeners]) listener();
}

/** Calls `listener` when the session is in doubt; returns the stop for it. */
export function onSessionDoubt(listener: () => void): () => void {
  doubtListeners.add(listener);
  return () => { doubtListeners.delete(listener); };
}

/** How long signing out waits for unsaved edits to be saved before asking whether to go without them. */
export const SIGN_OUT_SAVE_MS = 8_000;

/** Each check for unsaved edits, with what saves them. */
const unsavedWork = new Map<() => boolean, (() => Promise<unknown>) | undefined>();

/**
 * Registers a check for edits of the session's owner that are not saved yet (an island being decorated, or one left
 * while its save kept failing), and `save`, which saves them; signing out saves them first and asks before dropping
 * what is still unsaved. Returns the stop for it.
 */
export function trackUnsaved(check: () => boolean, save?: () => Promise<unknown>): () => void {
  unsavedWork.set(check, save);
  return () => { unsavedWork.delete(check); };
}

/** Whether signing out now would drop edits nobody saved. */
export const hasUnsavedWork = () => [...unsavedWork.keys()].some((check) => check());

/**
 * Saves the tracked edits before signing out, waiting up to `ms` for every save to end; resolves whether nothing is left
 * unsaved then.
 */
export function saveUnsavedWork(ms: number = SIGN_OUT_SAVE_MS): Promise<boolean> {
  const saves = [...unsavedWork.values()].flatMap((save) => (save ? [Promise.resolve().then(save).catch(() => undefined)] : []));
  if (!saves.length) return Promise.resolve(!hasUnsavedWork());
  return new Promise((done) => {
    const timer = setTimeout(() => done(!hasUnsavedWork()), ms);
    void Promise.all(saves).then(() => {
      clearTimeout(timer);
      done(!hasUnsavedWork());
    });
  });
}
