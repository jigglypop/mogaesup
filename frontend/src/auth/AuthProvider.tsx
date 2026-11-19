import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { authApi } from '../api/endpoints';
import type { Credentials, Registration, User } from '../api/types';
import { clearDrafts } from './drafts';
import { followSession, SESSION_RETRY_MS, SESSION_UNREACHABLE_AFTER } from './session';
import {
  expireSession,
  hasUnsavedWork,
  onSessionDoubt,
  onSessionLapse,
  onSessionRenewed,
  renewedElsewhere,
  sessionEpoch,
  sessionLapsed,
  setSessionOwner,
} from './sessionWork';

type AuthValue = {
  status: 'loading' | 'anonymous' | 'signedIn';
  user: User | null;
  /** The member whose session ran out (or ended in another tab) while signed in here, until anyone signs in or out. */
  lapsed: User | null;
  /** The server has not said who is signed in after several tries; the screens wait and offer `retry`. */
  unreachable: boolean;
  /** Asks the server again now. */
  retry: () => void;
  login: (body: Credentials) => Promise<User>;
  register: (body: Registration) => Promise<User>;
  logout: () => Promise<void>;
  /** The name the account shows, after it was saved. */
  nameAs: (displayName: string) => void;
  /** The profile picture the account shows, after it was put up (a site path) or taken down (null). */
  pictureAs: (avatarUrl: string | null) => void;
};

const AuthContext = createContext<AuthValue | null>(null);

/**
 * A page left open asks who is signed in again once it is in view this long after it last asked. The server renews a
 * session it is asked about that way (as each opening of the app does), so a tab kept open for weeks stays signed in.
 */
export const SESSION_RENEW_MS = 12 * 60 * 60 * 1000;

/**
 * Changed in this browser's storage by a tab that signs in or out, or starts the session over. The other tabs hear it
 * (`storage`) and ask whose the session cookie is now; one that missed it (asleep, or kept for Back and Forward) finds
 * it changed once it is shown.
 */
export const SESSION_MARK = 'mogaesup:session';
/**
 * How a mark ends when the tab that changed it started the same member's session over (a password change, signing out
 * the other devices, see `startOver`): the browser has a new cookie, so refusals of the old one are no longer news.
 */
export const RENEWED_MARK = ':renewed';

const readMark = () => {
  try {
    return localStorage.getItem(SESSION_MARK);
  } catch {
    return null;
  }
};
/** Changes the mark for the other tabs; returns it as it is stored now. */
const changeMark = (renewed = false) => {
  try {
    localStorage.setItem(SESSION_MARK, `${Date.now()}:${Math.random().toString(36).slice(2)}${renewed ? RENEWED_MARK : ''}`);
  } catch {
    // Storage may be unavailable; the other tabs then learn of it from the server.
  }
  return readMark();
};

const sameMember = (a: User, b: User) =>
  a.id === b.id && a.username === b.username && a.displayName === b.displayName && a.role === b.role
  && (a.permissions ?? []).join() === (b.permissions ?? []).join();

/**
 * Asks the server who the session cookie belongs to, then follows sign-in and sign-out, in other tabs too. While the
 * server does not answer, nobody is taken for signed out: the screens wait, and it asks again. A session the server
 * stops taking (a 401 on any request, or a sign-out in another tab) signs the member out but keeps their unsaved work:
 * signing in again as them resumes it.
 *
 * The cookie is the whole site's, so another tab signing out, or in as someone else, changes who this one acts as. This
 * tab asks again when another tab changes `SESSION_MARK` (or it finds the mark changed once shown), and when a request
 * answers for someone else (`doubtSession`), and follows the answer; a password change or signing out the other devices
 * here marks the session renewed, so the other tabs take the new cookie for the same member.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [lapsed, setLapsed] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [failures, setFailures] = useState(0);
  const generation = useRef(0);
  const stopChecking = useRef<(() => void) | undefined>(undefined);
  const mounted = useRef(false);
  const changing = useRef(false);
  /** Whom the session belongs to: the signed-in member, or the one whose session lapsed. */
  const owner = useRef<User | null>(null);
  /** `SESSION_MARK` as this tab last knew it. */
  const mark = useRef<string | null>(null);
  /** The server has said who is signed in at least once. */
  const answered = useRef(false);
  /** An ask is on its way (or waiting to be sent again). */
  const asking = useRef(false);
  /** A request answered for someone else while this tab signed in or out: ask once that is done. */
  const heardMeanwhile = useRef(false);

  const accept = (who: User | null, signedOut = false) => {
    answered.current = true;
    setReady(true);
    setFailures(0);
    // A member who did not sign out here, taken for nobody, has lost their session (it ran out, or they signed out in
    // another tab): it lapses, if it has not already, and that alone ends nothing they left unsaved.
    if (!who && !signedOut && owner.current) {
      expireSession();
      return;
    }
    // Signing in leaves only this member's drafts in the browser, whoever was here before (a page reloaded after a lapse
    // knows nobody); signing out here leaves none.
    if (who) clearDrafts(who.id);
    else if (signedOut) clearDrafts();
    owner.current = who;
    setSessionOwner(who?.id ?? null);
    setUser(who);
    setLapsed(null);
  };
  /**
   * The answer to asking again once this tab knew who was signed in (asked at `sentAt`). The same member changes nothing
   * (but what the server now says about them). Nobody means their session ended elsewhere (another tab signed out): that
   * is taken as a lapse, so what they left unsaved here waits for them; unless the session started over since the
   * question went out, when the answer speaks of the old cookie. Someone else is followed as a sign-in here would be,
   * but not over edits the member left unsaved here: a sign-in made in another tab does not drop them, so this tab
   * lapses instead, and signing in here decides (as the member, it carries on; as anyone else, the sign-in page asks).
   */
  const follow = (who: User | null, sentAt: number) => {
    const known = owner.current;
    if (known && who && who.id !== known.id && hasUnsavedWork()) {
      setReady(true);
      setFailures(0);
      expireSession();
      return;
    }
    if (!known || sessionLapsed() || (who && who.id !== known.id)) {
      accept(who);
      return;
    }
    setReady(true);
    setFailures(0);
    if (!who) {
      expireSession(sentAt);
      return;
    }
    owner.current = who;
    if (!sameMember(who, known)) setUser(who);
  };
  const check = () => {
    const mine = generation.current;
    const current = () => mounted.current && mine === generation.current;
    let sentAt = sessionEpoch();
    asking.current = true;
    stopChecking.current = followSession(
      () => {
        sentAt = sessionEpoch();
        return authApi.me();
      },
      (who) => {
        if (!current()) return;
        asking.current = false;
        if (answered.current) follow(who, sentAt);
        else accept(who);
      },
      SESSION_RETRY_MS,
      (count) => {
        if (current() && !answered.current) setFailures(count);
      },
    );
  };
  /** Drops the ask on its way: its answer would speak for the session before whatever comes next. */
  const stopAsking = () => {
    generation.current++;
    stopChecking.current?.();
    asking.current = false;
  };
  /** Asks again now; `whenIdle` leaves it to an ask already on its way (focus and visibility arrive together). */
  const askAgain = (whenIdle = false) => {
    // A sign-in or sign-out on its way decides who is signed in; an answer to a question asked meanwhile would undo it.
    if (changing.current || (whenIdle && asking.current)) return;
    stopAsking();
    check();
  };
  /**
   * A request answered for someone else: asks again, now or, while this tab signs in or out itself, once that is done
   * (which of the two the cookie ended with is the server's to say).
   */
  const doubted = () => {
    if (changing.current) heardMeanwhile.current = true;
    else askAgain();
  };

  useEffect(() => {
    mounted.current = true;
    check();
    const stopLapse = onSessionLapse(() => {
      if (!mounted.current) return;
      setLapsed(owner.current);
      setUser(null);
    });
    const stopDoubt = onSessionDoubt(doubted);
    // This tab's answer brought the browser a new cookie for the same member: the other tabs hear it from the mark.
    const stopRenewed = onSessionRenewed(() => {
      mark.current = changeMark(true);
    });
    return () => {
      mounted.current = false;
      stopAsking();
      stopLapse();
      stopDoubt();
      stopRenewed();
    };
  }, []);

  // These asks renew the session; their answers are followed as any other (another tab may have signed in or out).
  useEffect(() => {
    if (!user) return undefined;
    let asked = Date.now();
    const renew = () => {
      if (document.visibilityState !== 'visible' || Date.now() - asked < SESSION_RENEW_MS) return;
      asked = Date.now();
      askAgain();
    };
    const timer = setInterval(renew, SESSION_RENEW_MS / 12);
    document.addEventListener('visibilitychange', renew);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', renew);
    };
  }, [user]);

  // Signed in again in another tab: coming back to this one finds out.
  useEffect(() => {
    if (!lapsed) return undefined;
    const back = () => {
      if (document.visibilityState === 'visible') askAgain(true);
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, [lapsed]);

  // Signed in or out, or the session started over, in another tab: this one asks whose the session cookie is now.
  useEffect(() => {
    mark.current = readMark();
    const changed = () => {
      // A sign-in or sign-out of this tab on its way answers it: done, it asks again if the mark changed meanwhile;
      // failed, the mark is compared again when the tab is next shown.
      if (changing.current) return;
      const now = readMark();
      if (now === mark.current) return;
      mark.current = now;
      // The other tab's answer brought the browser a new cookie: refusals of the old one are no longer news.
      if (now?.endsWith(RENEWED_MARK)) renewedElsewhere();
      askAgain();
    };
    const heard = (event: StorageEvent) => {
      if (event.key === SESSION_MARK) changed();
    };
    const shown = () => {
      if (document.visibilityState === 'visible') changed();
    };
    window.addEventListener('storage', heard);
    window.addEventListener('focus', shown);
    document.addEventListener('visibilitychange', shown);
    return () => {
      window.removeEventListener('storage', heard);
      window.removeEventListener('focus', shown);
      document.removeEventListener('visibilitychange', shown);
    };
  }, []);

  async function change<T>(action: () => Promise<T>, who: (result: T) => User | null, signedOut = false): Promise<T> {
    if (changing.current) throw new Error('세션 요청이 진행 중이에요');
    changing.current = true;
    heardMeanwhile.current = false;
    stopAsking();
    // Another tab signed in or out while this ran: whose the session cookie is now is asked once this is done.
    let missed = false;
    try {
      const result = await action();
      // Whatever was asked while it ran answers for the session before it.
      stopAsking();
      if (mounted.current) accept(who(result), signedOut);
      missed = readMark() !== mark.current;
      mark.current = changeMark();
      return result;
    } catch (error) {
      if (!ready && mounted.current) check();
      throw error;
    } finally {
      changing.current = false;
      const again = missed || heardMeanwhile.current;
      heardMeanwhile.current = false;
      if (again && mounted.current) askAgain();
    }
  }

  const nameAs = useCallback((displayName: string) => {
    setUser((current) => {
      if (!current || current.displayName === displayName) return current;
      const next = { ...current, displayName };
      owner.current = next;
      return next;
    });
  }, []);
  const pictureAs = useCallback((avatarUrl: string | null) => {
    setUser((current) => {
      if (!current || (current.avatarUrl ?? null) === avatarUrl) return current;
      const next = { ...current, avatarUrl };
      owner.current = next;
      return next;
    });
  }, []);
  const value = useMemo<AuthValue>(
    () => ({
      status: !ready ? 'loading' : user ? 'signedIn' : 'anonymous',
      user,
      lapsed,
      unreachable: !ready && failures >= SESSION_UNREACHABLE_AFTER,
      retry: () => {
        setFailures(0);
        askAgain();
      },
      login: async (body) => {
        const result = await change(() => authApi.login(body), (result) => result.user);
        return result.user;
      },
      register: async (body) => {
        const result = await change(() => authApi.register(body), (result) => result.user);
        return result.user;
      },
      logout: async () => {
        await change(authApi.logout, () => null, true);
      },
      nameAs,
      pictureAs,
    }),
    [ready, user, lapsed, failures, nameAs, pictureAs],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

/** The same, for pieces that may also show outside the provider (the loading screen). */
export const useOptionalAuth = (): AuthValue | null => useContext(AuthContext);
